/**
 * Repo-root `./.env` + `env/.env.*` preset operations.
 *
 * `acc-deploy.sh` drives `container/{beta,production}/podman-compose.yml`,
 * whose `env_file:` directives all point at `../../.env` — i.e. the
 * repo-root `./.env`.  `env/use.sh` calls it "the canonical sourced
 * file" and `acc-deploy.sh setup` scaffolds it from `./.env.example`.
 * That is the only env file the running stack actually sources, so
 * that is what this module reads/writes.  (Earlier versions targeted
 * `deploy/.env`, which the current compose no longer sources.)
 *
 * Per-model presets live under `env/.env.<name>` and are committed
 * (operator-shareable templates with no secrets); the operator
 * copies one into `./.env` then edits API keys.
 *
 * This module is the panel's read/write surface for those files.
 * Pure-fs; no PD or NATS dependency; trivially unit-testable.
 */

import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';


export interface PresetSummary {
  /** The preset's short name (without the `.env.` prefix). */
  name: string;
  /** Absolute path to the preset file. */
  path: string;
  /** First non-blank "Preset for …" comment line, when present. */
  blurb: string;
}


export interface DeployEnv {
  /** Whole file content; `undefined` when `./.env` does not exist yet. */
  contents: string | undefined;
  /** Absolute path the panel writes to on save (repo-root `./.env`). */
  path: string;
}


// ---------------------------------------------------------------------------
// Preset listing
// ---------------------------------------------------------------------------


export async function listPresets(repoRoot: string): Promise<PresetSummary[]> {
  const dir = join(repoRoot, 'env');
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: PresetSummary[] = [];
  for (const e of entries) {
    if (!e.startsWith('.env.') || e === '.env.example') {
      continue;
    }
    const path = join(dir, e);
    const name = e.slice('.env.'.length);
    const blurb = await readPresetBlurb(path);
    out.push({ name, path, blurb });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}


async function readPresetBlurb(path: string): Promise<string> {
  try {
    const text = await readFile(path, { encoding: 'utf-8' });
    for (const line of text.split('\n').slice(0, 6)) {
      const trimmed = line.replace(/^#+\s*/, '').trim();
      if (
        trimmed.toLowerCase().startsWith('preset for') ||
        trimmed.toLowerCase().startsWith('canonical')
      ) {
        return trimmed;
      }
    }
  } catch {
    // best-effort
  }
  return '';
}


// ---------------------------------------------------------------------------
// repo-root ./.env read + write + apply-preset
// ---------------------------------------------------------------------------


export async function readDeployEnv(repoRoot: string): Promise<DeployEnv> {
  const path = join(repoRoot, '.env');
  try {
    const contents = await readFile(path, { encoding: 'utf-8' });
    return { contents, path };
  } catch {
    return { contents: undefined, path };
  }
}


export async function writeDeployEnv(
  repoRoot: string,
  contents: string,
): Promise<string> {
  const path = join(repoRoot, '.env');
  await writeFile(path, contents, { encoding: 'utf-8' });
  return path;
}


export interface ApplyPresetResult {
  ok: boolean;
  /** Path of the .bak when an existing ./.env was preserved. */
  backupPath: string | undefined;
  /** Resolved path of the new ./.env. */
  path: string;
  reason?: string;
}


/**
 * Copy `env/.env.<presetName>` into repo-root `./.env`, preserving any
 * existing `./.env` as `./.env.bak` first.  Mirrors exactly what the
 * `env/use.sh` shell script does (it also copies into `${REPO_ROOT}/.env`
 * and backs up to `.env.bak`) so the panel's operator UX matches the
 * CLI flow.
 */
export async function applyPreset(
  repoRoot: string,
  presetName: string,
): Promise<ApplyPresetResult> {
  const presetPath = join(repoRoot, 'env', `.env.${presetName}`);
  const targetPath = join(repoRoot, '.env');
  let backupPath: string | undefined;

  try {
    // Back up the existing ./.env if present.
    try {
      const existing = await readFile(targetPath);
      backupPath = `${targetPath}.bak`;
      await writeFile(backupPath, existing);
    } catch {
      // No existing ./.env — no backup needed.
    }

    await copyFile(presetPath, targetPath);
    return { ok: true, path: targetPath, backupPath };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, path: targetPath, backupPath, reason };
  }
}


// ---------------------------------------------------------------------------
// Profile toggles — extract + patch ACC_DEPLOY env exports
// ---------------------------------------------------------------------------


export type ProfileKey =
  | 'TUI'
  | 'CODING_SPLIT'
  | 'AUTORESEARCHER'
  | 'MCP_ECHO'
  | 'WEBGUI'
  | 'DETACH';


/** Operator-toggleable profile keys the panel surfaces as checkboxes. */
export const PROFILE_KEYS: readonly ProfileKey[] = [
  'TUI',
  'CODING_SPLIT',
  'AUTORESEARCHER',
  'MCP_ECHO',
  'WEBGUI',
  'DETACH',
];


export type ProfileState = Record<ProfileKey, boolean>;


/**
 * Parse a `KEY=VALUE` line — return the matching ProfileState
 * keyed by profile name.  Anything unrecognised stays at the
 * given defaults.
 */
export function readProfileState(envContents: string | undefined): ProfileState {
  const defaults: ProfileState = {
    TUI: true,
    CODING_SPLIT: false,
    AUTORESEARCHER: false,
    MCP_ECHO: false,
    WEBGUI: false,
    DETACH: true,
  };
  if (envContents === undefined) {
    return defaults;
  }
  const out = { ...defaults };
  for (const raw of envContents.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if ((PROFILE_KEYS as readonly string[]).includes(key)) {
      (out as Record<string, boolean>)[key] = value.toLowerCase() === 'true';
    }
  }
  return out;
}


/**
 * Patch (or insert) the profile-key lines in an env file body.
 * Lines that are commented out are left commented; lines that are
 * present + uncommented are updated; missing lines are appended.
 *
 * Conservative — we never delete unrelated lines, never reorder
 * non-profile content, and never strip comments.
 */
export function patchProfileState(
  envContents: string | undefined,
  state: ProfileState,
): string {
  const present = new Set<string>();
  const lines = (envContents ?? '').split('\n');
  const patched = lines.map((raw) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return raw;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      return raw;
    }
    const key = trimmed.slice(0, eq).trim();
    if ((PROFILE_KEYS as readonly string[]).includes(key)) {
      present.add(key);
      const value = state[key as ProfileKey] ? 'true' : 'false';
      return `${key}=${value}`;
    }
    return raw;
  });

  // Append any missing profile keys at the end.
  const trailing: string[] = [];
  for (const key of PROFILE_KEYS) {
    if (!present.has(key)) {
      trailing.push(`${key}=${state[key] ? 'true' : 'false'}`);
    }
  }
  if (trailing.length > 0) {
    if (patched.length > 0 && patched[patched.length - 1] !== '') {
      patched.push('');
    }
    patched.push('# --- profiles toggled by the ACC stack panel ---');
    patched.push(...trailing);
  }
  return patched.join('\n');
}
