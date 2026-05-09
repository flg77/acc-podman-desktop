/**
 * Smoke tests for the path-resolution helper.
 *
 * Vitest aliases `@podman-desktop/api` to
 * `tests/_mocks/podman-desktop-api.ts` (configured in
 * vitest.config.ts) so the helper exercises without a running
 * Podman Desktop.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveAccPaths } from '../src/core/paths';
import { __setConfig } from './_mocks/podman-desktop-api';


function fakeAccRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acc-fixture-'));
  mkdirSync(join(dir, 'acc'), { recursive: true });
  writeFileSync(join(dir, 'acc-deploy.sh'), '#!/usr/bin/env bash\n');
  writeFileSync(join(dir, 'acc', '__init__.py'), '');
  return dir;
}


describe('resolveAccPaths', () => {
  beforeEach(() => {
    __setConfig('acc', 'repoPath', '');
    // Override HOME so the home-walk doesn't pick up an existing
    // checkout on the developer's machine.
    process.env.HOME = mkdtempSync(join(tmpdir(), 'home-empty-'));
  });

  it('returns undefined when no install can be located', async () => {
    const result = await resolveAccPaths();
    expect(result).toBeUndefined();
  });

  it('uses configured repoPath when it points at an ACC repo', async () => {
    const repo = fakeAccRepo();
    __setConfig('acc', 'repoPath', repo);
    const result = await resolveAccPaths();
    expect(result).toBeDefined();
    expect(result?.repoPath).toBe(repo);
    expect(result?.deployScript.endsWith('acc-deploy.sh')).toBe(true);
  });

  it('rejects a configured repoPath missing the ACC marker files', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'empty-'));
    __setConfig('acc', 'repoPath', empty);
    const result = await resolveAccPaths();
    expect(result).toBeUndefined();
  });

  it('walks common home-relative locations when no path is configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-with-repo-'));
    process.env.HOME = home;
    // Plant a fake ACC checkout at the well-known home-relative
    // location the resolver walks.
    const target = join(home, 'agentic-cell-corpus');
    mkdirSync(join(target, 'acc'), { recursive: true });
    writeFileSync(join(target, 'acc-deploy.sh'), '#!/usr/bin/env bash\n');
    writeFileSync(join(target, 'acc', '__init__.py'), '');

    __setConfig('acc', 'repoPath', '');
    const result = await resolveAccPaths();
    expect(result).toBeDefined();
    expect(result?.repoPath).toBe(target);
  });
});
