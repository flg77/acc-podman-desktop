/**
 * Cluster topology — subscribes to acc.{cid}.> and renders the
 * same data the TUI prompt pane's cluster panel shows.
 *
 * v0.0.1 stub: registers the command + logs that subscription
 * would happen here.  Real NATS subscription + webview rendering
 * lands in PR-2 (the dedicated cluster topology PR).
 */

import * as extensionApi from '@podman-desktop/api';

import type { AccPaths } from '../core/paths';

interface RegisterArgs {
  paths: AccPaths | undefined;
  log: extensionApi.OutputChannel;
}

export function registerClusterTopology(
  args: RegisterArgs,
): extensionApi.Disposable[] {
  const { log } = args;

  const showCommand = extensionApi.commands.registerCommand(
    'acc.cluster.show',
    async () => {
      const config = extensionApi.configuration.getConfiguration('acc');
      const cid = config.get<string>('collectiveId') ?? 'sol-01';
      const natsUrl = config.get<string>('natsUrl') ?? 'nats://localhost:4222';
      log.info(`cluster.show: would subscribe to acc.${cid}.> on ${natsUrl}`);

      // PR-2 will wire the actual NATS subscription + webview here.
      extensionApi.window.showInformationMessage(
        `ACC cluster topology view — coming in PR #2.  Today, run ` +
          `\`acc-tui\` and press 7 (Prompt) for the live cluster panel.`,
      );
    },
  );

  return [showCommand];
}
