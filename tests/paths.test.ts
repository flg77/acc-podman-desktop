/**
 * Smoke tests for the path-resolution helper.
 *
 * The extension's `@podman-desktop/api` import is mocked so the
 * helper can be exercised without a running Podman Desktop.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@podman-desktop/api', () => {
  const config: Record<string, unknown> = { repoPath: '' };
  return {
    configuration: {
      getConfiguration: () => ({
        get: <T>(key: string): T => config[key] as T,
      }),
    },
    __setConfig: (k: string, v: unknown) => {
      config[k] = v;
    },
  };
});

import { resolveAccPaths } from '../src/core/paths';
import * as pdApi from '@podman-desktop/api';

function fakeAccRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acc-fixture-'));
  mkdirSync(join(dir, 'acc'), { recursive: true });
  writeFileSync(join(dir, 'acc-deploy.sh'), '#!/usr/bin/env bash\n');
  writeFileSync(join(dir, 'acc', '__init__.py'), '');
  return dir;
}

describe('resolveAccPaths', () => {
  beforeEach(() => {
    (pdApi as unknown as { __setConfig: (k: string, v: unknown) => void })
      .__setConfig('repoPath', '');
  });

  it('returns undefined when no install can be located', async () => {
    // Override HOME so the home-walk doesn't pick up an existing repo
    // on the developer's machine.
    const prev = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), 'home-empty-'));
    try {
      const result = await resolveAccPaths();
      expect(result).toBeUndefined();
    } finally {
      process.env.HOME = prev;
    }
  });

  it('uses configured repoPath when it points at an ACC repo', async () => {
    const repo = fakeAccRepo();
    (pdApi as unknown as { __setConfig: (k: string, v: unknown) => void })
      .__setConfig('repoPath', repo);
    const result = await resolveAccPaths();
    expect(result).toBeDefined();
    expect(result?.repoPath).toBe(repo);
    expect(result?.deployScript.endsWith('acc-deploy.sh')).toBe(true);
  });

  it('rejects a configured repoPath missing the ACC marker files', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'empty-'));
    (pdApi as unknown as { __setConfig: (k: string, v: unknown) => void })
      .__setConfig('repoPath', empty);
    // HOME also points at an empty dir so the home-walk doesn't help.
    const prev = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), 'home-empty-'));
    try {
      const result = await resolveAccPaths();
      expect(result).toBeUndefined();
    } finally {
      process.env.HOME = prev;
    }
  });
});
