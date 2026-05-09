/**
 * Examples runner — surfaces the two ACC demo scenarios as
 * one-click commands.
 *
 * Each example shells out to `examples/<name>/run.sh` in the
 * configured ACC repo.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';

import * as extensionApi from '@podman-desktop/api';

import type { AccPaths } from '../core/paths';

interface RegisterArgs {
  paths: AccPaths | undefined;
  log: extensionApi.OutputChannel;
}

interface ExampleSpec {
  /** Command id registered with PD. */
  commandId: string;
  /** User-facing label (already in package.json). */
  label: string;
  /** Path under examples/ in the runtime repo. */
  exampleDir: string;
  /** CLI args to pass into run.sh (e.g. --topic <slug>). */
  args: string[];
}

const EXAMPLES: ExampleSpec[] = [
  {
    commandId: 'acc.examples.coding-split',
    label: 'coding-split-skills',
    exampleDir: 'examples/coding_split_skills',
    args: [],
  },
  {
    commandId: 'acc.examples.autoresearcher',
    label: 'acc-autoresearcher',
    exampleDir: 'examples/acc_autoresearcher',
    // v0.0.1 ships a sensible default; PR-3 (examples panel) will
    // surface a topic-slug input modal.
    args: ['--topic', 'agentic-ai-strategy'],
  },
];

export function registerExamples(
  args: RegisterArgs,
): extensionApi.Disposable[] {
  const { paths, log } = args;

  return EXAMPLES.map((spec) =>
    extensionApi.commands.registerCommand(spec.commandId, async () => {
      if (paths === undefined) {
        extensionApi.window.showErrorMessage(
          'ACC repo not configured.  Set "acc.repoPath" in settings.',
        );
        return;
      }

      const runScript = path.join(paths.repoPath, spec.exampleDir, 'run.sh');
      log.info(`example "${spec.label}": ${runScript} ${spec.args.join(' ')}`);

      const child = spawn(runScript, spec.args, {
        cwd: paths.repoPath,
        env: process.env,
        shell: false,
      });
      child.stdout.on('data', (c: Buffer) => log.info(c.toString().trimEnd()));
      child.stderr.on('data', (c: Buffer) => log.warn(c.toString().trimEnd()));

      const exitCode = await new Promise<number>((resolve) => {
        child.on('close', resolve);
      });
      if (exitCode === 0) {
        extensionApi.window.showInformationMessage(
          `Example "${spec.label}" started.  Open acc-tui to watch the cluster panel.`,
        );
      } else {
        extensionApi.window.showErrorMessage(
          `Example "${spec.label}" exited ${exitCode}; see the ACC log.`,
        );
      }
    }),
  );
}
