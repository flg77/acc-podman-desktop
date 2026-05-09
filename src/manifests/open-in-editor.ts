/**
 * Open a file in the operator's default editor.
 *
 * Strategy:
 *   1. If $EDITOR is set, spawn it (preferred — the operator's
 *      explicit choice).
 *   2. Else delegate to the OS:
 *        - macOS:  `open <path>`
 *        - Windows: `start "" <path>` (via cmd)
 *        - Linux:  `xdg-open <path>`
 *
 * Read-only — the panel never modifies the manifest.  We just hand
 * the file off to whatever the operator already uses.
 */

import { spawn } from 'node:child_process';


export interface OpenResult {
  ok: boolean;
  command: string;
  /** Why we picked this command, or the failure reason. */
  reason: string;
}


export function openInEditor(filePath: string): OpenResult {
  const editor = process.env['EDITOR'];
  if (editor && editor.trim()) {
    spawnDetached(editor, [filePath]);
    return { ok: true, command: `${editor} ${filePath}`, reason: '$EDITOR set' };
  }

  switch (process.platform) {
    case 'darwin':
      spawnDetached('open', [filePath]);
      return { ok: true, command: `open ${filePath}`, reason: 'macOS default' };
    case 'win32':
      // On Windows the canonical "open with default app" trick is
      // `cmd /c start "" <path>` — `""` is the title (must be
      // present so cmd doesn't treat the path as the title when it
      // contains spaces).
      spawnDetached('cmd', ['/c', 'start', '""', filePath], true);
      return { ok: true, command: `start "" ${filePath}`, reason: 'Windows default' };
    default:
      spawnDetached('xdg-open', [filePath]);
      return { ok: true, command: `xdg-open ${filePath}`, reason: 'Linux default' };
  }
}


function spawnDetached(
  command: string,
  args: readonly string[],
  shell = false,
): void {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      shell,
    });
    child.unref();
  } catch {
    // Best-effort — if spawn fails (e.g. xdg-open not installed)
    // the panel surfaces a notification.  We don't throw out of
    // the message handler.
  }
}
