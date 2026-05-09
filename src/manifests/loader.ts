/**
 * Manifest loader for the runtime repo's roles/, skills/, mcps/.
 *
 * Pure-TS, read-only.  The extension never authors or edits these
 * files — operators do that in their editor of choice; we just
 * surface them in the browser panel.
 *
 * Schema mirrors the canonical YAML shape the runtime declares:
 *   - roles/<name>/role.yaml      → role.persona, max_parallel_tasks,
 *                                    default_skills, default_mcps,
 *                                    max_*_risk_level, estimator block.
 *   - skills/<name>/skill.yaml    → purpose, version, risk_level,
 *                                    domain_id, tags.
 *   - mcps/<name>/mcp.yaml        → purpose, transport, risk_level,
 *                                    allowed_tools, domain_id.
 *
 * Tolerant of partial / older manifests — fields absent on the wire
 * default to safe empty values.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';


// ---------------------------------------------------------------------------
// Shared shape — every manifest the panel surfaces
// ---------------------------------------------------------------------------


export interface RoleSummary {
  name: string;
  /** Filesystem path to the directory (operator may "Open in editor"). */
  dir: string;
  purpose: string;
  persona: string;
  domain_id: string;
  domain_receptors: string[];
  max_parallel_tasks: number;
  allowed_skills: string[];
  default_skills: string[];
  max_skill_risk_level: string;
  allowed_mcps: string[];
  default_mcps: string[];
  max_mcp_risk_level: string;
  estimator_strategy: string;
  /** Sub-paths of files the operator may want to open. */
  files: {
    role_md: string | undefined;
    role_yaml: string;
    system_prompt_md: string | undefined;
    eval_rubric_yaml: string | undefined;
  };
}


export interface SkillSummary {
  name: string;
  dir: string;
  purpose: string;
  version: string;
  risk_level: string;
  domain_id: string;
  tags: string[];
  files: {
    skill_yaml: string;
    adapter_py: string | undefined;
  };
}


export interface McpSummary {
  name: string;
  dir: string;
  purpose: string;
  transport: string;
  risk_level: string;
  allowed_tools: string[];
  domain_id: string;
  files: {
    mcp_yaml: string;
  };
}


// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------


export async function loadRoles(repoRoot: string): Promise<RoleSummary[]> {
  const rolesDir = join(repoRoot, 'roles');
  const entries = await listSubdirs(rolesDir);
  const out: RoleSummary[] = [];
  for (const name of entries) {
    if (name.startsWith('_') || name === 'TEMPLATE') {
      // Skip _base / templates the runtime uses internally.
      continue;
    }
    const dir = join(rolesDir, name);
    const summary = await loadRole(name, dir);
    if (summary !== undefined) {
      out.push(summary);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}


export async function loadSkills(repoRoot: string): Promise<SkillSummary[]> {
  const skillsDir = join(repoRoot, 'skills');
  const entries = await listSubdirs(skillsDir);
  const out: SkillSummary[] = [];
  for (const name of entries) {
    if (name.startsWith('_')) {
      continue;
    }
    const dir = join(skillsDir, name);
    const summary = await loadSkill(name, dir);
    if (summary !== undefined) {
      out.push(summary);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}


export async function loadMcps(repoRoot: string): Promise<McpSummary[]> {
  const mcpsDir = join(repoRoot, 'mcps');
  const entries = await listSubdirs(mcpsDir);
  const out: McpSummary[] = [];
  for (const name of entries) {
    if (name.startsWith('_')) {
      continue;
    }
    const dir = join(mcpsDir, name);
    const summary = await loadMcp(name, dir);
    if (summary !== undefined) {
      out.push(summary);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}


// ---------------------------------------------------------------------------
// Per-manifest readers
// ---------------------------------------------------------------------------


async function loadRole(name: string, dir: string): Promise<RoleSummary | undefined> {
  const yamlPath = join(dir, 'role.yaml');
  const yaml = await safeReadYaml(yamlPath);
  if (yaml === undefined) {
    return undefined;
  }
  const def = (yaml['role_definition'] as Record<string, unknown>) ?? {};
  const estimator = (def['estimator'] as Record<string, unknown>) ?? {};

  return {
    name,
    dir,
    purpose: asString(def['purpose']),
    persona: asString(def['persona']),
    domain_id: asString(def['domain_id']),
    domain_receptors: asStringArray(def['domain_receptors']),
    max_parallel_tasks: asInt(def['max_parallel_tasks'], 1),
    allowed_skills: asStringArray(def['allowed_skills']),
    default_skills: asStringArray(def['default_skills']),
    max_skill_risk_level: asString(def['max_skill_risk_level'], 'MEDIUM'),
    allowed_mcps: asStringArray(def['allowed_mcps']),
    default_mcps: asStringArray(def['default_mcps']),
    max_mcp_risk_level: asString(def['max_mcp_risk_level'], 'MEDIUM'),
    estimator_strategy: asString(estimator['strategy'], 'heuristic'),
    files: {
      role_md: await existsOrUndef(join(dir, 'role.md')),
      role_yaml: yamlPath,
      system_prompt_md: await existsOrUndef(join(dir, 'system_prompt.md')),
      eval_rubric_yaml: await existsOrUndef(join(dir, 'eval_rubric.yaml')),
    },
  };
}


async function loadSkill(name: string, dir: string): Promise<SkillSummary | undefined> {
  const yamlPath = join(dir, 'skill.yaml');
  const yaml = await safeReadYaml(yamlPath);
  if (yaml === undefined) {
    return undefined;
  }
  return {
    name,
    dir,
    purpose: asString(yaml['purpose']),
    version: asString(yaml['version']),
    risk_level: asString(yaml['risk_level'], 'LOW'),
    domain_id: asString(yaml['domain_id']),
    tags: asStringArray(yaml['tags']),
    files: {
      skill_yaml: yamlPath,
      adapter_py: await existsOrUndef(join(dir, 'adapter.py')),
    },
  };
}


async function loadMcp(name: string, dir: string): Promise<McpSummary | undefined> {
  const yamlPath = join(dir, 'mcp.yaml');
  const yaml = await safeReadYaml(yamlPath);
  if (yaml === undefined) {
    return undefined;
  }
  return {
    name,
    dir,
    purpose: asString(yaml['purpose']),
    transport: asString(yaml['transport'], 'http'),
    risk_level: asString(yaml['risk_level'], 'LOW'),
    allowed_tools: asStringArray(yaml['allowed_tools']),
    domain_id: asString(yaml['domain_id']),
    files: {
      mcp_yaml: yamlPath,
    },
  };
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}


async function safeReadYaml(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await readFile(path, { encoding: 'utf-8' });
    const parsed = parseYaml(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}


async function existsOrUndef(path: string): Promise<string | undefined> {
  try {
    await stat(path);
    return path;
  } catch {
    return undefined;
  }
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
