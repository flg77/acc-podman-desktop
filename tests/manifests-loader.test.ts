/**
 * Manifest loader tests — pure-fs integration with tmpdir fixtures.
 *
 * Each test plants a small fake repo with one or two manifest
 * subdirectories and asserts the loader's summary fields match
 * the canonical YAML shape.
 *
 * The loader is tolerant: missing fields default; unparseable YAML
 * is skipped (the directory just doesn't appear in the result).
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadMcps,
  loadRoles,
  loadSkills,
} from '../src/manifests/loader';


function fakeRepo(): string {
  return mkdtempSync(join(tmpdir(), 'acc-loader-'));
}


function plantRole(
  repoRoot: string,
  name: string,
  yaml: string,
  extras: { roleMd?: boolean; systemPrompt?: boolean; rubric?: boolean } = {},
): void {
  const dir = join(repoRoot, 'roles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'role.yaml'), yaml);
  if (extras.roleMd) {
    writeFileSync(join(dir, 'role.md'), '# Role\n');
  }
  if (extras.systemPrompt) {
    writeFileSync(join(dir, 'system_prompt.md'), 'You are an agent.\n');
  }
  if (extras.rubric) {
    writeFileSync(
      join(dir, 'eval_rubric.yaml'),
      'criteria:\n  correctness: {weight: 1.0}\n',
    );
  }
}


function plantSkill(
  repoRoot: string,
  name: string,
  yaml: string,
  withAdapter = true,
): void {
  const dir = join(repoRoot, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'skill.yaml'), yaml);
  if (withAdapter) {
    writeFileSync(join(dir, 'adapter.py'), '# adapter\n');
  }
}


function plantMcp(repoRoot: string, name: string, yaml: string): void {
  const dir = join(repoRoot, 'mcps', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mcp.yaml'), yaml);
}


// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------


describe('loadRoles', () => {
  it('returns an empty list when roles/ does not exist', async () => {
    const repo = fakeRepo();
    const result = await loadRoles(repo);
    expect(result).toEqual([]);
  });

  it('reads canonical role.yaml shape', async () => {
    const repo = fakeRepo();
    plantRole(repo, 'coding_agent', `
role_definition:
  purpose: "Generate, review, and test code artefacts."
  persona: "analytical"
  domain_id: "software_engineering"
  domain_receptors:
    - "software_engineering"
    - "security_audit"
  max_parallel_tasks: 4
  allowed_skills: [echo, code_review]
  default_skills: [echo]
  max_skill_risk_level: "MEDIUM"
  allowed_mcps: [echo_server]
  default_mcps: [echo_server]
  max_mcp_risk_level: "HIGH"
  estimator:
    strategy: "heuristic"
`, { roleMd: true, systemPrompt: true, rubric: true });

    const roles = await loadRoles(repo);
    expect(roles).toHaveLength(1);
    const r = roles[0]!;
    expect(r.name).toBe('coding_agent');
    expect(r.purpose).toBe('Generate, review, and test code artefacts.');
    expect(r.persona).toBe('analytical');
    expect(r.domain_id).toBe('software_engineering');
    expect(r.domain_receptors).toEqual(['software_engineering', 'security_audit']);
    expect(r.max_parallel_tasks).toBe(4);
    expect(r.default_skills).toEqual(['echo']);
    expect(r.allowed_skills).toEqual(['echo', 'code_review']);
    expect(r.max_skill_risk_level).toBe('MEDIUM');
    expect(r.default_mcps).toEqual(['echo_server']);
    expect(r.max_mcp_risk_level).toBe('HIGH');
    expect(r.estimator_strategy).toBe('heuristic');
    expect(r.files.role_md).toBeDefined();
    expect(r.files.system_prompt_md).toBeDefined();
    expect(r.files.eval_rubric_yaml).toBeDefined();
  });

  it('skips _base / TEMPLATE directories', async () => {
    const repo = fakeRepo();
    plantRole(repo, '_base', 'role_definition:\n  purpose: "base"\n');
    plantRole(repo, 'TEMPLATE', 'role_definition:\n  purpose: "tpl"\n');
    plantRole(repo, 'real_role', 'role_definition:\n  purpose: "real"\n');
    const roles = await loadRoles(repo);
    expect(roles.map((r) => r.name)).toEqual(['real_role']);
  });

  it('skips directories whose role.yaml does not parse', async () => {
    const repo = fakeRepo();
    plantRole(repo, 'good_role', 'role_definition:\n  purpose: "ok"\n');
    plantRole(repo, 'broken_role', '{not: valid yaml: at all:: ');
    const roles = await loadRoles(repo);
    expect(roles.map((r) => r.name)).toEqual(['good_role']);
  });

  it('defaults missing fields to empty / safe values', async () => {
    const repo = fakeRepo();
    plantRole(repo, 'minimal', 'role_definition:\n  purpose: "min"\n');
    const r = (await loadRoles(repo))[0]!;
    expect(r.max_parallel_tasks).toBe(1);
    expect(r.default_skills).toEqual([]);
    expect(r.max_skill_risk_level).toBe('MEDIUM');
    expect(r.estimator_strategy).toBe('heuristic');
    expect(r.files.role_md).toBeUndefined();
  });

  it('returns roles sorted by name', async () => {
    const repo = fakeRepo();
    for (const n of ['zeta', 'alpha', 'mu']) {
      plantRole(repo, n, 'role_definition:\n  purpose: "x"\n');
    }
    const roles = await loadRoles(repo);
    expect(roles.map((r) => r.name)).toEqual(['alpha', 'mu', 'zeta']);
  });
});


// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------


describe('loadSkills', () => {
  it('reads canonical skill.yaml shape', async () => {
    const repo = fakeRepo();
    plantSkill(repo, 'echo', `
purpose: "Round-trip text"
version: "0.1.0"
risk_level: "LOW"
domain_id: "diagnostic"
tags:
  - "test"
  - "diagnostic"
`);
    const skills = await loadSkills(repo);
    expect(skills).toHaveLength(1);
    const s = skills[0]!;
    expect(s.name).toBe('echo');
    expect(s.purpose).toBe('Round-trip text');
    expect(s.version).toBe('0.1.0');
    expect(s.risk_level).toBe('LOW');
    expect(s.tags).toEqual(['test', 'diagnostic']);
    expect(s.files.adapter_py).toBeDefined();
  });

  it('omits adapter_py when the file is missing', async () => {
    const repo = fakeRepo();
    plantSkill(repo, 'no_adapter',
      'purpose: "x"\nrisk_level: "LOW"\n', /* withAdapter */ false);
    const s = (await loadSkills(repo))[0]!;
    expect(s.files.adapter_py).toBeUndefined();
  });

  it('skips _base under skills/', async () => {
    const repo = fakeRepo();
    plantSkill(repo, '_base', 'purpose: "base"\n');
    plantSkill(repo, 'echo', 'purpose: "echo"\n');
    const skills = await loadSkills(repo);
    expect(skills.map((s) => s.name)).toEqual(['echo']);
  });
});


// ---------------------------------------------------------------------------
// MCPs
// ---------------------------------------------------------------------------


describe('loadMcps', () => {
  it('reads canonical mcp.yaml shape', async () => {
    const repo = fakeRepo();
    plantMcp(repo, 'echo_server', `
purpose: "Smoke-test MCP server."
transport: "http"
risk_level: "LOW"
domain_id: "diagnostic"
allowed_tools:
  - "echo"
`);
    const mcps = await loadMcps(repo);
    expect(mcps).toHaveLength(1);
    const m = mcps[0]!;
    expect(m.name).toBe('echo_server');
    expect(m.transport).toBe('http');
    expect(m.risk_level).toBe('LOW');
    expect(m.allowed_tools).toEqual(['echo']);
  });

  it('returns an empty list when mcps/ is missing', async () => {
    expect(await loadMcps(fakeRepo())).toEqual([]);
  });

  it('skips manifest-less directories', async () => {
    const repo = fakeRepo();
    mkdirSync(join(repo, 'mcps', 'no_manifest'), { recursive: true });
    plantMcp(repo, 'real_mcp',
      'purpose: "real"\ntransport: "http"\nrisk_level: "MEDIUM"\n');
    const mcps = await loadMcps(repo);
    expect(mcps.map((m) => m.name)).toEqual(['real_mcp']);
  });
});
