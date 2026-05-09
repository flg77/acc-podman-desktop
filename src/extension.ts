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
import { registerStackPanel } from './stack/panel';
import { registerClusterTopology } from './cluster/topology';
import { registerExamples } from './examples/registry';
import { registerExamplesPanel } from './examples/panel';
import { registerManifestBrowser } from './manifests/panel';
import { registerAiLabPanel } from './ailab/panel';
import { registerCompliancePanel } from './compliance/panel';
import { registerPerformancePanel } from './performance/panel';
import { registerKaidenPanel } from './kaiden/panel';
import { registerPromptPanel } from './prompt/panel';
import { resolveAccPaths, type AccPaths } from './core/paths';
import { consoleLogger } from './core/logger';
import { panicRegistry } from './core/panic';
import {
  validateNatsUrl,
  validateRepoPath,
} from './core/health';

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

  // Settings hardening — validate acc.repoPath + acc.natsUrl on
  // activation and on every change, surface a toast on failure.
  await runSettingsHealthCheck(log);
  const onConfigChange = extensionApi.configuration.onDidChangeConfiguration?.(
    async (e) => {
      // PD's `ConfigurationChangeEvent` is shape-compatible with VS
      // Code's; we re-check on any acc.* change.
      if (
        e === undefined ||
        typeof (e as { affectsConfiguration?: unknown }).affectsConfiguration !== 'function' ||
        (e as { affectsConfiguration: (s: string) => boolean }).affectsConfiguration('acc')
      ) {
        await runSettingsHealthCheck(log);
      }
    },
  );

  // Panic-stop command — disposes every panel that registered a
  // tear-down handle (NATS subscriptions + spawned children).
  const panicStopCmd = extensionApi.commands.registerCommand(
    'acc.panicStop',
    async () => {
      const labels = panicRegistry.labels();
      if (labels.length === 0) {
        extensionApi.window.showInformationMessage(
          'ACC panic stop: nothing to tear down.',
        );
        return;
      }
      const result = await panicRegistry.tearDownAll(log);
      const summary = result.tornDown.length > 0
        ? `Tore down ${result.tornDown.length}: ${result.tornDown.join(', ')}`
        : 'Nothing to tear down.';
      if (result.errors.length > 0) {
        extensionApi.window.showWarningMessage(
          `${summary}; errors: ${result.errors.join(' | ')}`,
        );
      } else {
        extensionApi.window.showInformationMessage(`ACC panic stop: ${summary}`);
      }
    },
  );

  disposables = [
    ...registerStackCommands({ paths, log }),
    ...registerStackPanel(paths, log),
    ...registerClusterTopology({ paths, log }),
    ...registerExamples({ paths, log }),
    ...registerExamplesPanel(paths, log),
    ...registerManifestBrowser(paths, log),
    ...registerAiLabPanel(paths, log),
    ...registerCompliancePanel(paths, log),
    ...registerPerformancePanel(paths, log),
    ...registerKaidenPanel(paths, log),
    ...registerPromptPanel(paths, log),
    panicStopCmd,
    ...(onConfigChange ? [onConfigChange] : []),
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

async function runSettingsHealthCheck(log: ReturnType<typeof consoleLogger>): Promise<void> {
  const config = extensionApi.configuration.getConfiguration('acc');
  const repoPath = config.get<string>('repoPath') ?? '';
  const natsUrl = config.get<string>('natsUrl') ?? '';

  const repo = await validateRepoPath(repoPath);
  if (!repo.ok) {
    log.warn(`config: acc.repoPath invalid — ${repo.reason}`);
    extensionApi.window.showWarningMessage(
      `ACC repoPath: ${repo.reason}.  Set "acc.repoPath" to your agentic-cell-corpus checkout.`,
    );
  } else {
    log.info(`config: acc.repoPath ok — ${repo.reason}`);
  }

  const nats = validateNatsUrl(natsUrl);
  if (!nats.ok) {
    log.warn(`config: acc.natsUrl invalid — ${nats.reason}`);
    extensionApi.window.showWarningMessage(
      `ACC natsUrl: ${nats.reason}.  Expected scheme://host:port (nats:// / tls:// / ws://).`,
    );
  } else {
    log.info(`config: acc.natsUrl ok — ${nats.reason}`);
  }
}


export type { AccPaths };
