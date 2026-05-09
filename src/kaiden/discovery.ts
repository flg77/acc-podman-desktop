/**
 * Detect Kaiden's `kdn` workspace registry on disk + parse its
 * `mcp.commands[]` / `mcp.servers[]` arrays.
 *
 * `kdn` (the CLI sibling of the Kaiden GUI) stores MCP entries in
 * plain JSON at `<workspace>/.kaiden/workspace.json` — the
 * documented, stable shape.  The Kaiden GUI's on-disk format is
 * undocumented; for that case the panel offers an
 * operator-pasted-JSON fallback (`parseKaidenWorkspace` works on
 * either an absolute path or the raw text).
 *
 * Pure-fn parser; live discovery is a thin shell over `readFile`
 * with a small set of candidate paths (operator can override via
 * the `acc.kaidenWorkspacePath` setting).
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';


/** Single normalized entry — collapsed across `commands[]` + `servers[]`. */
export interface KaidenEntry {
  name: string;
  /** `stdio` for `commands[]`, `sse` for `servers[]`. */
  transport: 'stdio' | 'sse';
  /** Argv for stdio entries; empty for SSE. */
  command: string[];
  /** Endpoint URL for SSE entries; empty for stdio. */
  url: string;
  /** Names of env vars referenced (values stripped — never carried). */
  env_var_names: string[];
  /** Names of HTTP headers referenced (values stripped). */
  header_names: string[];
}


/** Parse the `kdn` `workspace.json` JSON text into normalized entries. */
export function parseKaidenWorkspace(jsonText: string): KaidenEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (raw === null || typeof raw !== 'object') {
    return [];
  }
  const mcp = (raw as Record<string, unknown>)['mcp'];
  if (mcp === null || typeof mcp !== 'object' || mcp === undefined) {
    return [];
  }
  const out: KaidenEntry[] = [];

  const commands = (mcp as Record<string, unknown>)['commands'];
  if (Array.isArray(commands)) {
    for (const c of commands) {
      const e = coerceCommand(c);
      if (e !== null) {
        out.push(e);
      }
    }
  }

  const servers = (mcp as Record<string, unknown>)['servers'];
  if (Array.isArray(servers)) {
    for (const s of servers) {
      const e = coerceServer(s);
      if (e !== null) {
        out.push(e);
      }
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}


function coerceCommand(raw: unknown): KaidenEntry | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const name = String(r['name'] ?? '').trim();
  if (!name) {
    return null;
  }
  const argv: string[] = [];
  const cmd = r['command'];
  if (typeof cmd === 'string' && cmd.trim().length > 0) {
    argv.push(cmd);
  }
  const args = r['args'];
  if (Array.isArray(args)) {
    for (const a of args) {
      if (typeof a === 'string') {
        argv.push(a);
      }
    }
  }
  const envObj = r['env'];
  const envNames =
    envObj !== null && typeof envObj === 'object' && !Array.isArray(envObj)
      ? Object.keys(envObj as Record<string, unknown>)
      : [];
  return {
    name,
    transport: 'stdio',
    command: argv,
    url: '',
    env_var_names: envNames.sort(),
    header_names: [],
  };
}


function coerceServer(raw: unknown): KaidenEntry | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const name = String(r['name'] ?? '').trim();
  const url = String(r['url'] ?? '').trim();
  if (!name || !url) {
    return null;
  }
  const headerObj = r['headers'];
  const headerNames =
    headerObj !== null && typeof headerObj === 'object' && !Array.isArray(headerObj)
      ? Object.keys(headerObj as Record<string, unknown>)
      : [];
  return {
    name,
    transport: 'sse',
    command: [],
    url,
    env_var_names: [],
    header_names: headerNames.sort(),
  };
}


// ---------------------------------------------------------------------------
// On-disk discovery
// ---------------------------------------------------------------------------


export interface DiscoveryResult {
  /** Path the entries were read from, or undefined when none was found. */
  sourcePath: string | undefined;
  entries: KaidenEntry[];
  /** Diagnostic message for the panel when sourcePath is undefined. */
  reason?: string;
}


/**
 * Try a small set of well-known paths.  Returns the first that
 * parses cleanly.  When `override` is set, only that path is tried.
 */
export async function discoverKaidenWorkspace(
  options: { override?: string; repoRoot?: string } = {},
): Promise<DiscoveryResult> {
  const candidates: string[] = [];
  if (options.override && options.override.trim().length > 0) {
    candidates.push(options.override);
  } else {
    if (options.repoRoot) {
      // Walk from the repo root and parents to find `.kaiden/workspace.json`.
      let dir = options.repoRoot;
      for (let i = 0; i < 6; i++) {
        candidates.push(join(dir, '.kaiden', 'workspace.json'));
        const parent = dirname(dir);
        if (parent === dir) {
          break;
        }
        dir = parent;
      }
    }
    candidates.push(join(process.cwd(), '.kaiden', 'workspace.json'));
    candidates.push(join(homedir(), '.kaiden', 'workspace.json'));
  }

  for (const path of candidates) {
    try {
      await stat(path);
    } catch {
      continue;
    }
    try {
      const text = await readFile(path, { encoding: 'utf-8' });
      const entries = parseKaidenWorkspace(text);
      return { sourcePath: path, entries };
    } catch (err) {
      return {
        sourcePath: undefined,
        entries: [],
        reason: `Failed to read ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  return {
    sourcePath: undefined,
    entries: [],
    reason:
      'No `.kaiden/workspace.json` found in repo / cwd / home.  Use the ' +
      '"Paste JSON" tab to import a workspace by hand.',
  };
}
