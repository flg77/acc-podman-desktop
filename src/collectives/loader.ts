/**
 * Loader for the runtime repo's `collectives/` agentset presets.
 *
 * Pure-TS, read-only.  Each `collectives/*.yaml` preset is an
 * `AgentCollectiveSpec` the operator applies with
 * `./acc-deploy.sh apply <name>` — the declarative replacement for
 * the legacy `CODING_SPLIT=true ./acc-deploy.sh up` env profiles.
 *
 * `apply` resolves a bare name against (first match wins)
 * `collectives/collective.<name>.yaml` then `collectives/<name>.yaml`
 * (see acc-deploy.sh), so we derive the friendly apply-name by
 * stripping the optional `collective.` prefix + `.yaml` suffix:
 *   collectives/collective.coding-split.yaml  → "coding-split"
 *   collectives/demo-coding.yaml              → "demo-coding"
 *
 * `packs.yaml` (the role→pack manifest) carries no `agents:` block
 * and is skipped; so is anything that doesn't parse to a spec with
 * an agents array.
 *
 * Tolerant of partial specs — absent fields default to safe empties.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';


export interface CollectiveAgent {
  role: string;
  /** Declared replicas; defaults to 1 when unset. */
  replicas: number;
  /** `cluster_id` the agent joins; '' when unset. */
  cluster: string;
  /** `model` id (references models.yaml); '' when unset. */
  model: string;
  /** Free-text purpose; '' when unset. */
  purpose: string;
}


export interface CollectiveSummary {
  /** Friendly apply-name — what `acc-deploy.sh apply <name>` takes. */
  name: string;
  /** Preset filename (basename), e.g. `collective.coding-split.yaml`. */
  file: string;
  /** Absolute path to the preset file. */
  path: string;
  /** `collective_id` the spec declares (NATS namespace). */
  collectiveId: string;
  /** First descriptive header-comment line, when present. */
  blurb: string;
  /** Family packs `apply` resolves + installs at boot. */
  requiredPackages: string[];
  agents: CollectiveAgent[];
  /** Distinct, order-preserving cluster ids across all agents. */
  clusters: string[];
  /** Total replica count (sum of per-agent replicas). */
  totalReplicas: number;
}


export async function loadCollectives(repoRoot: string): Promise<CollectiveSummary[]> {
  const dir = join(repoRoot, 'collectives');
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: CollectiveSummary[] = [];
  for (const file of entries) {
    if (!file.endsWith('.yaml') || file === 'packs.yaml') {
      continue;
    }
    const path = join(dir, file);
    const summary = await loadCollective(file, path);
    if (summary !== undefined) {
      out.push(summary);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}


async function loadCollective(
  file: string,
  path: string,
): Promise<CollectiveSummary | undefined> {
  let text: string;
  try {
    text = await readFile(path, { encoding: 'utf-8' });
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const spec = parsed as Record<string, unknown>;
  const rawAgents = spec['agents'];
  if (!Array.isArray(rawAgents)) {
    // Not an agentset spec (e.g. packs.yaml shape) — skip.
    return undefined;
  }

  const agents = rawAgents.map(toAgent).filter((a): a is CollectiveAgent => a !== undefined);
  const clusters: string[] = [];
  for (const a of agents) {
    if (a.cluster && !clusters.includes(a.cluster)) {
      clusters.push(a.cluster);
    }
  }
  const totalReplicas = agents.reduce((sum, a) => sum + a.replicas, 0);

  return {
    name: applyName(file),
    file,
    path,
    collectiveId: asString(spec['collective_id']),
    blurb: headerBlurb(text),
    requiredPackages: asStringArray(spec['required_packages']),
    agents,
    clusters,
    totalReplicas,
  };
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/**
 * Derive the `acc-deploy.sh apply <name>` token from a preset
 * filename: strip a leading `collective.` and the `.yaml` suffix.
 */
export function applyName(file: string): string {
  let name = file.replace(/\.yaml$/, '');
  if (name.startsWith('collective.')) {
    name = name.slice('collective.'.length);
  }
  return name;
}


/**
 * The first descriptive line of the leading `#` comment block —
 * skipping blank lines and pure decoration rules (`===`, `---`).
 * Stops at the first real YAML line.
 */
function headerBlurb(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      continue;
    }
    if (!line.startsWith('#')) {
      break; // reached YAML body
    }
    const stripped = line.replace(/^#+\s*/, '').trim();
    if (stripped === '' || /^[=\-]+$/.test(stripped)) {
      continue; // blank or decoration rule
    }
    return stripped;
  }
  return '';
}


function toAgent(raw: unknown): CollectiveAgent | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const a = raw as Record<string, unknown>;
  const role = asString(a['role']);
  if (role === '') {
    return undefined;
  }
  return {
    role,
    replicas: asInt(a['replicas'], 1),
    cluster: asString(a['cluster_id']),
    model: asString(a['model']),
    purpose: asString(a['purpose']),
  };
}


function asString(x: unknown, fallback = ''): string {
  return typeof x === 'string' ? x : fallback;
}


function asInt(x: unknown, fallback: number): number {
  if (typeof x === 'number' && Number.isFinite(x)) {
    return Math.floor(x);
  }
  if (typeof x === 'string') {
    const parsed = Number(x);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return fallback;
}


function asStringArray(x: unknown): string[] {
  if (!Array.isArray(x)) {
    return [];
  }
  return x.map((v) => (typeof v === 'string' ? v : String(v))).filter(Boolean);
}
