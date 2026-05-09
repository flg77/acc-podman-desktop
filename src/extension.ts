/**
 * ACC — Agentic Cell Corpus — Podman Desktop extension.
 *
 * Activation lifecycle:
 *  1. Read configuration (acc.repoPath, acc.collectiveId, acc.natsUrl).
 *  2. Resolve `acc-deploy.sh` + `acc-cli` paths.
 *  3. Register commands (stack lifecycle, examples, cluster topology).
 *  4. Register the cluster topology webview when activated.
 *
 * The extension is a UI shim over the existing ACC runtime + CLI; it
 * does NOT re-implement runtime behaviour.  See
 * docs/IMPLEMENTATION_subagent_clustering.md in the runtime repo for
 * the surfaces this extension renders.
 */

import * as extensionApi from '@podman-desktop/api';

import { registerStackCommands } from './stack/commands';
import { registerClusterTopology } from './cluster/topology';
import { registerExamples } from './examples/registry';
import { registerExamplesPanel } from './examples/panel';
import { resolveAccPaths, type AccPaths } from './core/paths';
import { consoleLogger } from './core/logger';

let disposables: extensionApi.Disposable[] = [];

export async function activate(
  extensionContext: extensionApi.ExtensionContext,
): Promise<void> {
  const log = consoleLogger('ACC');
  log.info('ACC extension activating…');

  const paths = await resolveAccPaths();
  if (paths === undefined) {
    extensionApi.window.showWarningMessage(
      'ACC repo not found.  Set "acc.repoPath" in settings or place ' +
        '`acc-deploy.sh` on PATH.',
    );
    log.warn('paths unresolved; commands registered but will report errors at invocation time');
  } else {
    log.info(`ACC repo: ${paths.repoPath}`);
    log.info(`acc-deploy.sh: ${paths.deployScript}`);
    log.info(`acc-cli: ${paths.cliBinary}`);
  }

  disposables = [
    ...registerStackCommands({ paths, log }),
    ...registerClusterTopology({ paths, log }),
    ...registerExamples({ paths, log }),
    ...registerExamplesPanel(paths, log),
  ];

  for (const d of disposables) {
    extensionContext.subscriptions.push(d);
  }

  log.info('ACC extension activated.');
}

export async function deactivate(): Promise<void> {
  for (const d of disposables) {
    try {
      d.dispose();
    } catch {
      // Best-effort teardown.
    }
  }
  disposables = [];
}

export type { AccPaths };
