/**
 * Resolve the operator's ACC runtime install location.
 *
 * Precedence:
 *   1. The configured `acc.repoPath` (if set + valid).
 *   2. Walk up from the user's home looking for an `acc-deploy.sh` +
 *      `acc/__init__.py` co-located.
 *   3. Look for `acc-deploy.sh` on PATH (then derive the repo root
 *      from its directory).
 *
 * Returns `undefined` when no install can be located — the extension
 * still loads but commands surface a friendly "configure path" error.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import * as extensionApi from '@podman-desktop/api';

export interface AccPaths {
  /** Absolute path to the agentic-cell-corpus repo root. */
  repoPath: string;
  /** Absolute path to acc-deploy.sh. */
  deployScript: string;
  /** acc-cli binary or "python -m acc.cli" launcher (resolved at call site). */
  cliBinary: string;
}

const SCRIPT_NAME = process.platform === 'win32' ? 'acc-deploy.sh' : 'acc-deploy.sh';

async function isReadable(p: string): Promise<boolean> {
  try {
    await fs.access(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function looksLikeAccRepo(repoRoot: string): Promise<boolean> {
  return (
    (await isReadable(path.join(repoRoot, SCRIPT_NAME))) &&
    (await isReadable(path.join(repoRoot, 'acc', '__init__.py')))
  );
}

export async function resolveAccPaths(): Promise<AccPaths | undefined> {
  const config = extensionApi.configuration.getConfiguration('acc');
  const configured = config.get<string>('repoPath') ?? '';

  // 1. Configured path.
  if (configured && (await looksLikeAccRepo(configured))) {
    return buildPaths(configured);
  }

  // 2. Common sibling locations under the user's home.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (home) {
    const candidates = [
      path.join(home, 'agentic-cell-corpus'),
      path.join(home, 'git', 'agentic-cell-corpus'),
      path.join(home, 'src', 'agentic-cell-corpus'),
      path.join(home, 'Downloads', 'git', 'agentic', 'agentic-cell-corpus'),
    ];
    for (const c of candidates) {
      if (await looksLikeAccRepo(c)) {
        return buildPaths(c);
      }
    }
  }

  return undefined;
}

function buildPaths(repoRoot: string): AccPaths {
  return {
    repoPath: repoRoot,
    deployScript: path.join(repoRoot, SCRIPT_NAME),
    // CLI is invoked by name; the actual binary location depends on
    // whether the operator installed it via pip-install or a venv.
    // The runner module spawns it via `python -m acc.cli` when not
    // on PATH.
    cliBinary: 'acc-cli',
  };
}
