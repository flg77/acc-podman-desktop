/**
 * Health-check validators — pure-fn / fs-only path tests.
 *
 * `probeNats` is not exercised here (would need a live broker);
 * `validateRepoPath` and `validateNatsUrl` cover everything the
 * settings change-listener calls into.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateNatsUrl, validateRepoPath } from '../src/core/health';


function fakeRepo(): string {
  return mkdtempSync(join(tmpdir(), 'acc-health-'));
}


describe('validateRepoPath', () => {
  it('treats empty path as auto-detect (ok=true)', async () => {
    const r = await validateRepoPath('');
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('auto-detect');
  });

  it('treats whitespace-only path as auto-detect', async () => {
    expect((await validateRepoPath('   ')).ok).toBe(true);
  });

  it('rejects a path that does not exist', async () => {
    const r = await validateRepoPath('/definitely/not/a/real/path/__acc');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('does not exist');
  });

  it('rejects a path that is a regular file, not a directory', async () => {
    const repo = fakeRepo();
    const file = join(repo, 'thing.txt');
    writeFileSync(file, 'x');
    const r = await validateRepoPath(file);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not a directory');
  });

  it('rejects a directory missing acc-deploy.sh', async () => {
    const repo = fakeRepo();
    const r = await validateRepoPath(repo);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('acc-deploy.sh');
  });

  it('rejects when acc-deploy.sh exists but compose file is missing', async () => {
    const repo = fakeRepo();
    writeFileSync(join(repo, 'acc-deploy.sh'), '#!/bin/sh');
    const r = await validateRepoPath(repo);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('podman-compose.yml');
  });

  it('accepts a complete fake install', async () => {
    const repo = fakeRepo();
    writeFileSync(join(repo, 'acc-deploy.sh'), '#!/bin/sh');
    mkdirSync(join(repo, 'deploy'), { recursive: true });
    writeFileSync(join(repo, 'deploy', 'podman-compose.yml'), 'version: 3');
    const r = await validateRepoPath(repo);
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('present');
  });
});


describe('validateNatsUrl', () => {
  it('rejects empty', () => {
    expect(validateNatsUrl('').ok).toBe(false);
  });

  it('rejects bare host without scheme', () => {
    const r = validateNatsUrl('localhost:4222');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/parseable|scheme/);
  });

  it('rejects unsupported scheme', () => {
    const r = validateNatsUrl('http://localhost:4222');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('http');
  });

  it('accepts nats://', () => {
    const r = validateNatsUrl('nats://localhost:4222');
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('nats://');
  });

  it('accepts tls://', () => {
    expect(validateNatsUrl('tls://nats.example.com:4222').ok).toBe(true);
  });

  it('accepts ws:// + wss://', () => {
    expect(validateNatsUrl('ws://localhost:8080').ok).toBe(true);
    expect(validateNatsUrl('wss://nats.example.com:443').ok).toBe(true);
  });

  it('rejects URL with no host', () => {
    const r = validateNatsUrl('nats://');
    expect(r.ok).toBe(false);
  });
});
