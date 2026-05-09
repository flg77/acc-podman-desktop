/**
 * Convert a Kaiden `KaidenEntry` into an ACC `mcp.yaml` body and
 * write it to `mcps/<name>/mcp.yaml`.
 *
 * Operator-supplied at import time:
 *   * `risk_level` — one of LOW / MEDIUM / HIGH / CRITICAL.  Kaiden
 *     has no equivalent field; ACC's governance model demands the
 *     operator state intent.
 *   * `allowed_tools[]` — explicit allow-list.  Kaiden carries no
 *     per-tool gating, so we never auto-import an "all tools"
 *     entry; an empty list is allowed but the operator must
 *     confirm it.
 *
 * Secrets-handling: env-var values + HTTP-header values are NEVER
 * carried over.  We surface the *names* (e.g. `BRAVE_API_KEY`) so
 * the operator wires them into `deploy/.env` themselves.  This is
 * the heart of the "one-way / never reverse-trust" rule.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { KaidenEntry } from './discovery';


export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export const RISK_LEVELS: readonly RiskLevel[] = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
];


export interface ImportOptions {
  riskLevel: RiskLevel;
  /** Allow-list — `[]` means "no tools allowed yet, operator will edit". */
  allowedTools: string[];
  /** Optional override; defaults to `entry.name` slugified. */
  manifestName?: string;
}


export interface ImportResult {
  ok: boolean;
  /** Resolved manifest path (mcps/<name>/mcp.yaml) — even on failure. */
  path: string;
  /** Final manifest body (when ok). */
  contents: string;
  reason?: string;
}


/**
 * Build the ACC `mcp.yaml` body.  Pure-fn — exported for tests.
 */
export function buildMcpYaml(
  entry: KaidenEntry,
  opts: ImportOptions,
): string {
  const name = (opts.manifestName ?? slugify(entry.name)).trim();
  const transport = entry.transport === 'sse' ? 'sse' : 'stdio';
  const allowed = opts.allowedTools.filter((t) => t.trim().length > 0);
  const lines: string[] = [];

  lines.push(`# mcps/${name}/mcp.yaml — imported from Kaiden`);
  lines.push('# ');
  lines.push('# One-way import.  Kaiden has no per-tool gating + no risk');
  lines.push('# classification on its registry entries; the values below');
  lines.push("# were chosen by the operator at import time and DO NOT");
  lines.push('# come from Kaiden.  Edit by hand to refine.');
  lines.push('');
  lines.push(`purpose: ${quote('Imported from Kaiden: ' + entry.name)}`);
  lines.push(`version: "0.1.0"`);
  lines.push('');
  lines.push(`transport: ${quote(transport)}`);
  if (transport === 'stdio') {
    lines.push('command:');
    if (entry.command.length === 0) {
      lines.push('  []');
    } else {
      for (const c of entry.command) {
        lines.push(`  - ${quote(c)}`);
      }
    }
  } else {
    lines.push(`url: ${quote(entry.url)}`);
  }
  lines.push('timeout_s: 30');
  lines.push('api_key_env: ""');
  lines.push('');
  lines.push('allowed_tools:');
  if (allowed.length === 0) {
    lines.push('  # NB: empty allow-list = no tool calls permitted.  Add');
    lines.push('  # tool names below before the manifest is useful.');
    lines.push('  []');
  } else {
    for (const t of allowed) {
      lines.push(`  - ${quote(t)}`);
    }
  }
  lines.push('');
  lines.push('requires_actions: []');
  lines.push(`risk_level: ${quote(opts.riskLevel)}`);
  lines.push(`domain_id: "imported"`);
  lines.push(`tags: ["kaiden-import"]`);

  const refs = secretRefs(entry);
  if (refs.length > 0) {
    lines.push('');
    lines.push('# Secret references — Kaiden carried these values as env');
    lines.push("# vars / HTTP headers; the importer DELIBERATELY drops the");
    lines.push('# values and surfaces only the names.  Wire them into');
    lines.push('# deploy/.env and reference via api_key_env / your own');
    lines.push('# adapter before the MCP can authenticate.');
    for (const r of refs) {
      lines.push(`#   - ${r}`);
    }
  }

  lines.push('');
  lines.push('description: |');
  lines.push(`  Imported from Kaiden ${transport === 'sse' ? 'SSE server' : 'stdio command'}: ${entry.name}.`);
  lines.push('');
  lines.push('  Edit purpose / risk_level / allowed_tools to match the');
  lines.push("  actual capability surface of this server before granting");
  lines.push("  it to a role's allow-list.");

  return lines.join('\n') + '\n';
}


export async function importEntry(
  repoRoot: string,
  entry: KaidenEntry,
  opts: ImportOptions,
): Promise<ImportResult> {
  const name = (opts.manifestName ?? slugify(entry.name)).trim();
  const dir = join(repoRoot, 'mcps', name);
  const path = join(dir, 'mcp.yaml');
  if (!name) {
    return {
      ok: false,
      path,
      contents: '',
      reason: 'Empty manifest name',
    };
  }
  if (!RISK_LEVELS.includes(opts.riskLevel)) {
    return {
      ok: false,
      path,
      contents: '',
      reason: `Invalid risk_level: ${opts.riskLevel}`,
    };
  }
  try {
    const contents = buildMcpYaml(entry, opts);
    await mkdir(dir, { recursive: true });
    await writeFile(path, contents, { encoding: 'utf-8' });
    return { ok: true, path, contents };
  } catch (err) {
    return {
      ok: false,
      path,
      contents: '',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}


// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------


export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}


function quote(s: string): string {
  // Conservative double-quoted YAML scalar; escape backslash + quote.
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}


function secretRefs(entry: KaidenEntry): string[] {
  const refs: string[] = [];
  for (const n of entry.env_var_names) {
    refs.push(`env: ${n}`);
  }
  for (const n of entry.header_names) {
    refs.push(`header: ${n}`);
  }
  return refs;
}
