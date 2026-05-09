/**
 * Cluster topology — wires the aggregator + NATS subscriber + HTML
 * renderer together and exposes a webview the operator opens via
 * `ACC: Show cluster topology`.
 *
 * v0.0.2 (PR #2) — first working iteration:
 *  * Real NATS subscription against `acc.{cid}.>`.
 *  * Pure-function aggregator (mirrors the TUI's fold logic).
 *  * 30 s grace window for finished clusters.
 *  * Webview rendered from a single HTML string; auto-refresh on
 *    every wire update.
 *
 * PR #3 will replace the inline HTML with a Svelte panel + a
 * proper left-nav entry.  The aggregator + subscriber survive that
 * upgrade unchanged.
 */

import * as extensionApi from '@podman-desktop/api';

import type { AccPaths } from '../core/paths';
import type { Logger } from '../core/logger';
import { panicRegistry } from '../core/panic';
import { TopologyAggregator } from './aggregator';
import { renderSnapshot } from './renderer';
import { startSubscriber, type SubscriberHandle } from './subscriber';

interface RegisterArgs {
  paths: AccPaths | undefined;
  log: Logger;
}

interface TopologyState {
  aggregator: TopologyAggregator;
  subscriber: SubscriberHandle | undefined;
  webviewPanel: extensionApi.WebviewPanel | undefined;
  /** Debounce token for the webview re-render. */
  refreshScheduled: boolean;
}


export function registerClusterTopology(
  args: RegisterArgs,
): extensionApi.Disposable[] {
  const { log } = args;
  const state: TopologyState = {
    aggregator: new TopologyAggregator(),
    subscriber: undefined,
    webviewPanel: undefined,
    refreshScheduled: false,
  };

  const disposables: extensionApi.Disposable[] = [];

  const showCommand = extensionApi.commands.registerCommand(
    'acc.cluster.show',
    async () => {
      try {
        await openTopologyPanel(state, log);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`cluster.show failed: ${msg}`);
        extensionApi.window.showErrorMessage(
          `ACC cluster topology failed to open: ${msg}`,
        );
      }
    },
  );
  disposables.push(showCommand);

  // Lifecycle disposable that tears the subscription down at
  // extension deactivation.
  disposables.push({
    dispose: () => {
      if (state.subscriber !== undefined) {
        void state.subscriber.stop();
        state.subscriber = undefined;
      }
      if (state.webviewPanel !== undefined) {
        try {
          state.webviewPanel.dispose();
        } catch {
          // best-effort
        }
        state.webviewPanel = undefined;
      }
    },
  });

  return disposables;
}


async function openTopologyPanel(
  state: TopologyState,
  log: Logger,
): Promise<void> {
  const config = extensionApi.configuration.getConfiguration('acc');
  const cid = config.get<string>('collectiveId') ?? 'sol-01';
  const natsUrl = config.get<string>('natsUrl') ?? 'nats://localhost:4222';

  // 1. Reveal an existing panel if present.
  if (state.webviewPanel !== undefined) {
    try {
      state.webviewPanel.reveal();
      return;
    } catch {
      state.webviewPanel = undefined;
    }
  }

  // 2. Create a fresh webview panel.
  // PD's WebviewOptions does NOT carry an `enableScripts` field
  // (unlike VS Code's API).  Default options accept HTML payloads
  // directly; we don't need to ship local resources for v0.0.2.
  const panel = extensionApi.window.createWebviewPanel(
    'acc.clusterTopology',
    'ACC Cluster Topology',
  );
  state.webviewPanel = panel;
  panel.webview.html = wrapHtml(
    renderSnapshot(state.aggregator.liveClusters()),
    cid,
    natsUrl,
  );
  panel.onDidDispose(() => {
    state.webviewPanel = undefined;
    if (state.subscriber !== undefined) {
      void state.subscriber.stop();
      state.subscriber = undefined;
    }
  });

  // 3. Spin up the subscription if it isn't already running.
  if (state.subscriber === undefined) {
    log.info(`cluster.show: starting subscriber for acc.${cid}.> on ${natsUrl}`);
    state.subscriber = await startSubscriber(state.aggregator, {
      natsUrl,
      collectiveId: cid,
      onUpdate: () => scheduleRefresh(state, cid, natsUrl),
      logger: {
        info: (m) => log.info(m),
        warn: (m) => log.warn(m),
        error: (m) => log.error(m),
      },
    });
    // Wire panic-stop — torn down on natural panel dispose too.
    const handle = panicRegistry.register({
      label: `cluster(${cid})`,
      dispose: async () => {
        if (state.subscriber !== undefined) {
          await state.subscriber.stop();
          state.subscriber = undefined;
        }
        if (state.webviewPanel !== undefined) {
          try {
            state.webviewPanel.dispose();
          } catch {
            // best-effort
          }
          state.webviewPanel = undefined;
        }
      },
    });
    panel.onDidDispose(() => handle.unregister());
  }

  // 4. Drive a periodic re-render so the 30 s grace-window filter
  //    drops finished clusters even if no new wire events arrive.
  const interval = setInterval(() => {
    if (state.webviewPanel !== undefined) {
      paint(state, cid, natsUrl);
    }
  }, 5_000);
  panel.onDidDispose(() => clearInterval(interval));
}


/** Coalesce many wire updates into a single re-render per tick. */
function scheduleRefresh(
  state: TopologyState,
  cid: string,
  natsUrl: string,
): void {
  if (state.refreshScheduled) {
    return;
  }
  state.refreshScheduled = true;
  setTimeout(() => {
    state.refreshScheduled = false;
    paint(state, cid, natsUrl);
  }, 100);
}


function paint(state: TopologyState, cid: string, natsUrl: string): void {
  if (state.webviewPanel === undefined) {
    return;
  }
  state.webviewPanel.webview.html = wrapHtml(
    renderSnapshot(state.aggregator.liveClusters()),
    cid,
    natsUrl,
  );
}


function wrapHtml(body: string, cid: string, natsUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ACC Cluster Topology</title>
<style>
  body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         padding: 1rem; background: #1a1a2e; color: #eee; }
  h1   { font-size: 1.05rem; margin: 0 0 0.5rem 0; }
  .meta { color: #888; font-size: 0.85rem; margin-bottom: 1rem; }
  .acc-cluster-empty { color: #888; font-style: italic; }
  .acc-cluster-header { font-size: 1rem; margin-bottom: 0.75rem; }
  .acc-cluster-total  { color: #aaa; font-weight: normal; }
  .acc-cluster        { padding: 0.5rem 0.75rem; margin: 0.5rem 0;
                        background: #232342; border-left: 3px solid #4a90e2;
                        border-radius: 4px; }
  .acc-cluster--finished { border-left-color: #4caf50; opacity: 0.7; }
  .acc-cluster-row    { display: flex; gap: 0.6rem; align-items: center;
                        flex-wrap: wrap; }
  .acc-cluster-id     { font-family: monospace; color: #4a90e2; }
  .acc-cluster-role   { font-weight: 600; color: #ccc; }
  .acc-cluster-count  { color: #888; }
  .acc-cluster-reason { color: #888; font-style: italic; }
  .acc-cluster-members { list-style: none; padding: 0.4rem 0 0 1rem; margin: 0; }
  .acc-member         { display: flex; gap: 0.5rem; align-items: center;
                        padding: 0.15rem 0; font-size: 0.92rem; }
  .acc-status         { font-size: 0.8rem; }
  .acc-status--running  { color: #ffd54f; }
  .acc-status--complete { color: #4caf50; }
  .acc-status--blocked  { color: #ef5350; }
  .acc-member-id      { font-family: monospace; color: #ccc; min-width: 14ch; }
  .acc-member-skill   { color: #ce93d8; }
  .acc-member-step    { color: #888; }
  .acc-member-status  { color: #888; font-size: 0.85rem; }
  .acc-iter           { color: #4a90e2; }
</style>
</head>
<body>
<h1>ACC Cluster Topology</h1>
<div class="meta">
  Collective: <code>${escapeAttr(cid)}</code>
  · NATS: <code>${escapeAttr(natsUrl)}</code>
  · Auto-refresh: 5 s + on wire updates
</div>
${body}
</body>
</html>`;
}


function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
