/**
 * Subprocess runner used by the examples panel + the standalone
 * commands.
 *
 * Wraps `child_process.spawn` in a small interface that:
 *   - Emits chunked stdout/stderr through a callback so the
 *     webview can tail live output.
 *   - Returns a Promise that resolves to the exit code.
 *   - Exposes a `kill()` for the panel's "abort" button (PR #4).
 *
 * Pure module — no PD API dependency — so it's unit-testable
 * without the webview.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export type ChunkKind = 'stdout' | 'stderr';

export interface RunnerOptions {
  /** Absolute path to the script / binary to invoke. */
  command: string;
  /** Args passed verbatim to the spawned process. */
  args?: readonly string[];
  /** Working directory.  Defaults to the script's parent. */
  cwd?: string;
  /** Extra env on top of process.env.  Useful for injecting
      `ACC_RUN_OUTPUT_DIR` etc. */
  env?: Record<string, string>;
  /** Called once per output chunk.  ``kind`` discriminates
      stdout vs stderr; the webview renders stderr in a warning
      colour. */
  onChunk?: (kind: ChunkKind, text: string) => void;
}

export interface RunnerHandle {
  /** Resolves to the process's exit code (0 on clean exit). */
  promise: Promise<number>;
  /** Best-effort kill — sends SIGTERM, then SIGKILL after 2 s. */
  kill: () => void;
  /** True until the process exits. */
  isRunning: () => boolean;
}


export function runScript(options: RunnerOptions): RunnerHandle {
  // shell: true on Windows so .bat / .sh-via-WSL invocations work
  // through cmd.exe.  Unix uses direct execve.  Args are still
  // passed via the array form so cmd's word-splitting cannot
  // misinterpret them.
  const child: ChildProcess = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    shell: process.platform === 'win32',
  });

  let running = true;
  const pipeChunk = (kind: ChunkKind) => (chunk: Buffer) => {
    if (options.onChunk) {
      try {
        options.onChunk(kind, chunk.toString());
      } catch {
        // Listener exception isolation — never let a buggy
        // callback crash the spawn.
      }
    }
  };

  child.stdout?.on('data', pipeChunk('stdout'));
  child.stderr?.on('data', pipeChunk('stderr'));

  const promise = new Promise<number>((resolve) => {
    child.on('close', (code) => {
      running = false;
      resolve(code ?? -1);
    });
    child.on('error', (err) => {
      running = false;
      options.onChunk?.('stderr', `\nspawn error: ${err.message}\n`);
      resolve(-1);
    });
  });

  return {
    promise,
    isRunning: () => running,
    kill: () => {
      if (!running) {
        return;
      }
      try {
        child.kill('SIGTERM');
      } catch {
        // best-effort
      }
      setTimeout(() => {
        if (running) {
          try {
            child.kill('SIGKILL');
          } catch {
            // best-effort
          }
        }
      }, 2_000);
    },
  };
}
