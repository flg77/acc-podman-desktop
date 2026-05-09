/**
 * Stack lifecycle commands — `up` / `down` / `status`.
 *
 * Shells out to the operator's `acc-deploy.sh`.  The extension does
 * NOT replicate the script's logic; it just wires buttons to the
 * canonical entry point.
 */

import { spawn } from 'node:child_process';

import * as extensionApi from '@podman-desktop/api';

import type { AccPaths } from '../core/paths';

interface RegisterArgs {
  paths: AccPaths | undefined;
  log: extensionApi.OutputChannel;
}

export function registerStackCommands(
  args: RegisterArgs,
): extensionApi.Disposable[] {
  const { paths, log } = args;

  const run = (subcommand: 'up' | 'down' | 'status') =>
    async (): Promise<void> => {
      if (paths === undefined) {
        extensionApi.window.showErrorMessage(
          'ACC repo not configured.  Set "acc.repoPath" in settings.',
        );
        return;
      }

      log.info(`stack ${subcommand}: invoking ${paths.deployScript}`);

      const child = spawn(paths.deployScript, [subcommand], {
        cwd: paths.repoPath,
        env: { ...process.env, DETACH: 'true' },
        shell: false,
      });

      child.stdout.on('data', (chunk: Buffer) => {
        log.info(chunk.toString().trimEnd());
      });
      child.stderr.on('data', (chunk: Buffer) => {
        log.warn(chunk.toString().trimEnd());
      });

      const exitCode = await new Promise<number>((resolve) => {
        child.on('close', resolve);
      });

      if (exitCode === 0) {
        extensionApi.window.showInformationMessage(`ACC stack ${subcommand}: OK`);
      } else {
        extensionApi.window.showErrorMessage(
          `ACC stack ${subcommand} failed (exit ${exitCode}); see the ACC log for details`,
        );
      }
    };

  return [
    extensionApi.commands.registerCommand('acc.stack.up', run('up')),
    extensionApi.commands.registerCommand('acc.stack.down', run('down')),
    extensionApi.commands.registerCommand('acc.stack.status', run('status')),
  ];
}
