/**
 * Subprocess runner tests — covers the contract that other modules
 * depend on:
 *   - exit code is delivered via the promise.
 *   - stdout + stderr chunks fan out to onChunk with the right kind.
 *   - kill() resolves the promise with non-zero.
 *   - onChunk listener throws are caught (exception isolation).
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';

import { runScript } from '../src/examples/runner';


/** Cross-platform helper — write a temp script and return its path. */
function tempScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'acc-runner-'));
  if (platform() === 'win32') {
    const p = join(dir, 'script.bat');
    writeFileSync(p, body);
    return p;
  }
  const p = join(dir, 'script.sh');
  writeFileSync(p, `#!/usr/bin/env bash\n${body}`);
  chmodSync(p, 0o755);
  return p;
}


describe('runScript', () => {
  it('streams stdout chunks via onChunk and resolves with exit 0', async () => {
    const script =
      platform() === 'win32'
        ? tempScript('@echo off\r\necho hello\r\nexit /b 0')
        : tempScript('echo hello\nexit 0');
    const chunks: string[] = [];
    const handle = runScript({
      command: script,
      onChunk: (kind, text) => {
        if (kind === 'stdout') {
          chunks.push(text);
        }
      },
    });
    const code = await handle.promise;
    expect(code).toBe(0);
    expect(chunks.join('')).toMatch(/hello/);
  });

  it('streams stderr chunks with kind=stderr', async () => {
    const script =
      platform() === 'win32'
        ? tempScript('@echo off\r\necho whoops 1>&2\r\nexit /b 0')
        : tempScript('echo whoops 1>&2\nexit 0');
    const collected: Array<['stdout' | 'stderr', string]> = [];
    const handle = runScript({
      command: script,
      onChunk: (kind, text) => collected.push([kind, text]),
    });
    await handle.promise;
    const stderrText = collected
      .filter(([k]) => k === 'stderr')
      .map(([, t]) => t)
      .join('');
    expect(stderrText).toMatch(/whoops/);
  });

  it('isolates onChunk listener exceptions', async () => {
    const script =
      platform() === 'win32'
        ? tempScript('@echo off\r\necho one\r\nexit /b 0')
        : tempScript('echo one\nexit 0');
    let calls = 0;
    const handle = runScript({
      command: script,
      onChunk: () => {
        calls++;
        throw new Error('listener bug');
      },
    });
    // Should NOT reject despite listener throwing.
    const code = await handle.promise;
    expect(code).toBe(0);
    expect(calls).toBeGreaterThan(0);
  });

  it('reports a non-zero exit code when the binary does not exist', async () => {
    // On Unix `spawn` fires the error event → runner returns -1.
    // On Windows with shell: true, cmd reports "command not found"
    // and exits with a non-zero code (typically 1).  Both satisfy
    // the contract callers care about: "did this succeed?"
    // answered by ``code === 0``.
    const handle = runScript({
      command: '/this/does/not/exist',
      onChunk: () => undefined,
    });
    const code = await handle.promise;
    expect(code).not.toBe(0);
    expect(handle.isRunning()).toBe(false);
  });
});
