/**
 * Collectives loader tests — pure-fs integration with tmpdir
 * fixtures.  Each test plants a small fake `collectives/` directory
 * and asserts the parsed agentset summaries.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyName, loadCollectives } from '../src/collectives/loader';


function fakeRepo(): string {
  return mkdtempSync(join(tmpdir(), 'acc-collectives-'));
}


function plant(repo: string, file: string, body: string): void {
  const dir = join(repo, 'collectives');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body);
}


const CODING_SPLIT = `# ACC collective preset — coding-split agentset.
# =============================================================================
# Three peer coding_agent workers.

collective_id: sol-01

required_packages:
  - "@acc/workspace-roles@^1.0"

agents:
  - role: coding_agent
    replicas: 3
    cluster_id: backend
    model: claude-haiku
    purpose: "Implement the planner's decomposed coding tasks."
`;


describe('applyName', () => {
  it('strips the collective. prefix + .yaml suffix', () => {
    expect(applyName('collective.coding-split.yaml')).toBe('coding-split');
  });

  it('strips only .yaml when there is no collective. prefix', () => {
    expect(applyName('demo-coding.yaml')).toBe('demo-coding');
  });
});


describe('loadCollectives', () => {
  it('returns [] when collectives/ does not exist', async () => {
    expect(await loadCollectives(fakeRepo())).toEqual([]);
  });

  it('parses name, collective_id, blurb, packages, and agents', async () => {
    const repo = fakeRepo();
    plant(repo, 'collective.coding-split.yaml', CODING_SPLIT);
    const [c] = await loadCollectives(repo);

    expect(c?.name).toBe('coding-split');
    expect(c?.file).toBe('collective.coding-split.yaml');
    expect(c?.collectiveId).toBe('sol-01');
    expect(c?.blurb).toBe('ACC collective preset — coding-split agentset.');
    expect(c?.requiredPackages).toEqual(['@acc/workspace-roles@^1.0']);
    expect(c?.agents).toHaveLength(1);
    expect(c?.agents[0]).toEqual({
      role: 'coding_agent',
      replicas: 3,
      cluster: 'backend',
      model: 'claude-haiku',
      purpose: "Implement the planner's decomposed coding tasks.",
    });
  });

  it('derives clusters + totalReplicas across agents', async () => {
    const repo = fakeRepo();
    plant(repo, 'collective.mix.yaml', `collective_id: sol-01
agents:
  - role: a
    cluster_id: ctl
  - role: b
    replicas: 2
    cluster_id: ctl
  - role: c
    replicas: 4
    cluster_id: work
`);
    const [c] = await loadCollectives(repo);
    expect(c?.clusters).toEqual(['ctl', 'work']);
    // a defaults to 1 replica, b=2, c=4 → 7
    expect(c?.totalReplicas).toBe(7);
  });

  it('defaults replicas to 1 and tolerates missing cluster/model/purpose', async () => {
    const repo = fakeRepo();
    plant(repo, 'collective.assistant.yaml', `collective_id: sol-01
agents:
  - role: assistant
`);
    const [c] = await loadCollectives(repo);
    expect(c?.agents[0]).toEqual({
      role: 'assistant',
      replicas: 1,
      cluster: '',
      model: '',
      purpose: '',
    });
    expect(c?.totalReplicas).toBe(1);
    expect(c?.clusters).toEqual([]);
  });

  it('skips packs.yaml (no agents block)', async () => {
    const repo = fakeRepo();
    plant(repo, 'collective.coding-split.yaml', CODING_SPLIT);
    plant(repo, 'packs.yaml', `control_roles:
  - arbiter
packs:
  '@acc/business-roles':
    - financial_analyst
`);
    const names = (await loadCollectives(repo)).map((c) => c.name);
    expect(names).toEqual(['coding-split']);
  });

  it('skips non-yaml + specs without an agents array', async () => {
    const repo = fakeRepo();
    plant(repo, 'collective.coding-split.yaml', CODING_SPLIT);
    plant(repo, 'README.md', '# not a preset\n');
    plant(repo, 'collective.broken.yaml', 'collective_id: sol-01\nagents: not-a-list\n');
    const names = (await loadCollectives(repo)).map((c) => c.name);
    expect(names).toEqual(['coding-split']);
  });

  it('returns presets sorted by name', async () => {
    const repo = fakeRepo();
    const body = 'collective_id: sol-01\nagents:\n  - role: a\n';
    plant(repo, 'collective.zeta.yaml', body);
    plant(repo, 'demo-alpha.yaml', body);
    plant(repo, 'collective.mu.yaml', body);
    const names = (await loadCollectives(repo)).map((c) => c.name);
    expect(names).toEqual(['demo-alpha', 'mu', 'zeta']);
  });
});
