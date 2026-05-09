/**
 * Wire an AI Lab Model Service base URL into `deploy/.env`.
 *
 * Sets three variables — the headline cross-extension story:
 *
 *   ACC_LLM_BACKEND=openai_compat
 *   ACC_OPENAI_BASE_URL=http://localhost:<port>/v1
 *   ACC_OPENAI_MODEL=<model name, when known>
 *
 * Conservative patcher: keeps comments + unrelated lines intact;
 * updates an existing uncommented assignment in place; appends a
 * new section at the bottom for missing keys.  Mirrors the
 * `patchProfileState` shape from `stack/env-file.ts`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';


export interface WireBaseUrlOptions {
  baseUrl: string;
  modelName?: string;
}


export interface WireResult {
  ok: boolean;
  /** Final patched env body. */
  contents: string;
  /** Resolved path the function wrote to. */
  path: string;
  reason?: string;
}


/**
 * Pure-fn patcher.  Exported for unit tests; the live wrapper below
 * does the read + write.
 */
export function patchAccLlmKeys(
  envContents: string | undefined,
  opts: WireBaseUrlOptions,
): string {
  const wanted: Record<string, string> = {
    ACC_LLM_BACKEND: 'openai_compat',
    ACC_OPENAI_BASE_URL: opts.baseUrl,
  };
  if (opts.modelName && opts.modelName.trim().length > 0) {
    wanted['ACC_OPENAI_MODEL'] = opts.modelName.trim();
  }
  const lines = (envContents ?? '').split('\n');
  const present = new Set<string>();
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
    if (Object.prototype.hasOwnProperty.call(wanted, key)) {
      present.add(key);
      return `${key}=${wanted[key]}`;
    }
    return raw;
  });
  const trailing: string[] = [];
  for (const k of Object.keys(wanted)) {
    if (!present.has(k)) {
      trailing.push(`${k}=${wanted[k]}`);
    }
  }
  if (trailing.length > 0) {
    if (patched.length > 0 && patched[patched.length - 1] !== '') {
      patched.push('');
    }
    patched.push('# --- wired from AI Lab by the ACC extension ---');
    patched.push(...trailing);
  }
  return patched.join('\n');
}


export async function wireBaseUrl(
  repoRoot: string,
  opts: WireBaseUrlOptions,
): Promise<WireResult> {
  const targetDir = join(repoRoot, 'deploy');
  const targetPath = join(targetDir, '.env');
  try {
    await mkdir(targetDir, { recursive: true });
    let existing: string | undefined;
    try {
      existing = await readFile(targetPath, { encoding: 'utf-8' });
    } catch {
      existing = undefined;
    }
    const contents = patchAccLlmKeys(existing, opts);
    await writeFile(targetPath, contents, { encoding: 'utf-8' });
    return { ok: true, contents, path: targetPath };
  } catch (err) {
    return {
      ok: false,
      contents: '',
      path: targetPath,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
