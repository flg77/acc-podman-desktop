/**
 * Performance dashboard panel.
 *
 * Subscribes `acc.{cid}.>`, folds HEARTBEAT + TASK_PROGRESS +
 * TASK_COMPLETE + PLAN into a PerformanceAggregator, pushes
 * snapshot fragments into the webview on every change.
 *
 * Read-only — no write side; PR #8 owns the only inbound write
 * surface (oversight decisions).
 *
 * Bidirectional message protocol:
 *   webview → host:
 *     { type: 'refresh' }
 *   host → webview:
 *     { type: 'snapshot', html: { latency, agents, capabilities, costs } }
 *     { type: 'meta',     cid, natsUrl, connected, message? }
 *     { type: 'error',    message }
 */

import * as extensionApi from '@podman-desktop/api';
import { connect, type NatsConnection, type Subscription } from 'nats';

import type { AccPaths } from '../core/paths';
import type { Logger } from '../core/logger';
import { panicRegistry } from '../core/panic';
import { PerformanceAggregator } from './aggregator';
import { decodeFrame } from '../cluster/subscriber';
import {
  renderAgentTable,
  renderCapabilityStats,
  renderLatencyHeader,
  renderPlanCosts,
} from './renderer';


interface PanelState {
  panel: extensionApi.WebviewPanel;
  aggregator: PerformanceAggregator;
  nc: NatsConnection | undefined;
  sub: Subscription | undefined;
  cid: string;
  natsUrl: string;
  refreshScheduled: boolean;
  panicHandle: { unregister: () => void } | undefined;
}


export function registerPerformancePanel(
  _paths: AccPaths | undefined,
  log: Logger,
): extensionApi.Disposable[] {
  let state: PanelState | undefined;

  const showCommand = extensionApi.commands.registerCommand(
    'acc.performance.show',
    async () => {
      try {
        state = await openPanel(state, log);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`performance.show failed: ${msg}`);
        extensionApi.window.showErrorMessage(
          `ACC performance panel failed to open: ${msg}`,
        );
      }
    },
  );

  return [
    showCommand,
    {
      dispose: () => {
        if (state !== undefined) {
          teardown(state).catch(() => {
            // best-effort
          });
          state = undefined;
        }
      },
    },
  ];
}


async function openPanel(
  existing: PanelState | undefined,
  log: Logger,
): Promise<PanelState> {
  if (existing !== undefined) {
    try {
      existing.panel.reveal();
      paint(existing);
      return existing;
    } catch {
      // disposed externally — fall through
    }
  }

  const config = extensionApi.configuration.getConfiguration('acc');
  const cid = config.get<string>('collectiveId') ?? 'sol-01';
  const natsUrl = config.get<string>('natsUrl') ?? 'nats://localhost:4222';

  const panel = extensionApi.window.createWebviewPanel(
    'acc.performance',
    'ACC Performance',
  );
  panel.webview.html = renderInitialHtml();

  const state: PanelState = {
    panel,
    aggregator: new PerformanceAggregator(),
    nc: undefined,
    sub: undefined,
    cid,
    natsUrl,
    refreshScheduled: false,
    panicHandle: undefined,
  };
  state.panicHandle = panicRegistry.register({
    label: `performance(${cid})`,
    dispose: () => teardown(state),
  });

  panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) {
      return;
    }
    const msg = raw as Record<string, unknown>;
    if (String(msg['type'] ?? '') === 'refresh') {
      paint(state);
    }
  });

  panel.onDidDispose(() => {
    void teardown(state);
  });

  // Connect + subscribe.
  try {
    state.nc = await connect({ servers: natsUrl });
    log.info(`performance: connected to ${natsUrl}`);
    state.sub = state.nc.subscribe(`acc.${cid}.>`);
    void runSubscription(state, log);
    await postSafe(panel, {
      type: 'meta',
      cid,
      natsUrl,
      connected: true,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log.warn(`performance: NATS connect failed: ${m}`);
    await postSafe(panel, {
      type: 'meta',
      cid,
      natsUrl,
      connected: false,
      message: `NATS connect failed: ${m}`,
    });
  }

  // Periodic re-paint so latency-by-staleness drops as wall-clock advances.
  const interval = setInterval(() => paint(state), 5_000);
  panel.onDidDispose(() => clearInterval(interval));

  paint(state);
  return state;
}


async function runSubscription(state: PanelState, log: Logger): Promise<void> {
  if (state.sub === undefined) {
    return;
  }
  for await (const m of state.sub) {
    try {
      const decoded = decodeFrame(m.data);
      if (decoded === null) {
        continue;
      }
      const changed = state.aggregator.ingest(decoded);
      if (changed) {
        scheduleRepaint(state);
      }
    } catch (err) {
      log.error(
        `performance: ingest failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}


function scheduleRepaint(state: PanelState): void {
  if (state.refreshScheduled) {
    return;
  }
  state.refreshScheduled = true;
  setTimeout(() => {
    state.refreshScheduled = false;
    paint(state);
  }, 100);
}


function paint(state: PanelState): void {
  const snap = state.aggregator.getSnapshot();
  void postSafe(state.panel, {
    type: 'snapshot',
    html: {
      latency: renderLatencyHeader(snap),
      agents: renderAgentTable(snap),
      capabilities: renderCapabilityStats(snap),
      costs: renderPlanCosts(snap),
    },
  });
}


async function teardown(state: PanelState): Promise<void> {
  if (state.panicHandle !== undefined) {
    state.panicHandle.unregister();
    state.panicHandle = undefined;
  }
  if (state.sub !== undefined) {
    try {
      state.sub.unsubscribe();
    } catch {
      // best-effort
    }
    state.sub = undefined;
  }
  if (state.nc !== undefined) {
    try {
      await state.nc.drain();
    } catch {
      // best-effort
    }
    state.nc = undefined;
  }
  try {
    state.panel.dispose();
  } catch {
    // already disposed
  }
}


async function postSafe(
  panel: extensionApi.WebviewPanel,
  msg: Record<string, unknown>,
): Promise<void> {
  try {
    await panel.webview.postMessage(msg);
  } catch {
    // best-effort
  }
}


function renderInitialHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ACC Performance</title>
<style>
  body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         padding: 1rem; background: #1a1a2e; color: #eee; margin: 0; }
  h1 { font-size: 1.1rem; margin: 0 0 0.5rem 0; display: flex;
       align-items: center; gap: 0.75rem; }
  h2 { font-size: 0.95rem; margin: 1rem 0 0.4rem 0; color: #aaa;
       text-transform: uppercase; letter-spacing: 0.05em; }
  .meta { font-size: 0.8rem; color: #888; margin-bottom: 0.6rem; }
  .meta--bad { color: #ef5350; }
  .acc-section { background: #232342; border-radius: 4px;
                 padding: 0.75rem 1rem; margin-bottom: 0.75rem; }
  .acc-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  .acc-table th, .acc-table td { padding: 0.3rem 0.5rem; text-align: left;
                                  border-bottom: 1px solid #2c2c54;
                                  vertical-align: middle; }
  .acc-table th { color: #aaa; font-weight: 500; }
  .acc-empty { color: #888; font-style: italic; padding: 0.5rem 0; }
  .acc-warn { color: #ffb74d; font-weight: 600; }
  code { background: #15152a; padding: 1px 4px; border-radius: 3px;
         font-size: 0.85em; }

  .acc-latency { display: flex; gap: 1rem; margin-bottom: 0.75rem; }
  .acc-latency-cell { background: #232342; padding: 0.4rem 0.8rem;
                       border-radius: 4px; display: flex; flex-direction: column;
                       align-items: center; min-width: 5rem; }
  .acc-latency-label { font-size: 0.7rem; color: #888;
                        text-transform: uppercase; letter-spacing: 0.05em; }
  .acc-latency-value { font-family: ui-monospace, "Consolas", monospace;
                        font-weight: 600; }

  .acc-bp { font-size: 0.75rem; padding: 1px 6px; border-radius: 999px;
            background: #444; color: #ddd; font-weight: 500; }
  .acc-bp--ok    { background: #2e7d32; color: #fff; }
  .acc-bp--warn  { background: #ef6c00; color: #fff; }
  .acc-bp--crit  { background: #b71c1c; color: #fff; }

  .acc-token { font-family: ui-monospace, "Consolas", monospace; }
  .acc-token--ok    { color: #81c784; }
  .acc-token--warn  { color: #ffb74d; }
  .acc-token--crit  { color: #ef5350; font-weight: 600; }

  .acc-okrate { font-family: ui-monospace, "Consolas", monospace; }
  .acc-okrate--ok    { color: #81c784; }
  .acc-okrate--warn  { color: #ffb74d; }
  .acc-okrate--crit  { color: #ef5350; font-weight: 600; }

  .acc-spark { color: #4a90e2; vertical-align: middle; }
  .acc-spark--empty { color: #555; }
  .acc-drift-value { font-family: ui-monospace, "Consolas", monospace;
                      font-size: 0.78rem; color: #aaa; margin-left: 0.4rem; }
  .acc-step-label { font-size: 0.78rem; color: #888;
                     max-width: 18rem; white-space: nowrap; overflow: hidden;
                     text-overflow: ellipsis; }

  .acc-pill { font-size: 0.72rem; padding: 1px 6px; border-radius: 999px;
              background: #444; color: #ddd; font-weight: 500; }
  .acc-pill--skill { background: #1565c0; color: #fff; }
  .acc-pill--mcp   { background: #6a1b9a; color: #fff; }

  .acc-truncate { max-width: 18rem; white-space: nowrap; overflow: hidden;
                  text-overflow: ellipsis; display: inline-block;
                  vertical-align: bottom; }

  .acc-cost-grid { display: grid; gap: 0.5rem;
                   grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); }
  .acc-cost-card { background: #1a1a2e; padding: 0.5rem 0.75rem; border-radius: 4px; }
  .acc-cost-head { display: flex; justify-content: space-between; gap: 0.5rem;
                    margin-bottom: 0.25rem; font-size: 0.85rem; }
  .acc-cost-numbers { font-family: ui-monospace, "Consolas", monospace;
                       color: #aaa; }
  .acc-cost-bar { height: 8px; background: #15152a; border-radius: 4px;
                   overflow: hidden; }
  .acc-cost-fill { height: 100%; }
  .acc-cost-fill--ok      { background: #4caf50; }
  .acc-cost-fill--warn    { background: #ffb74d; }
  .acc-cost-fill--crit    { background: #b71c1c; }
  .acc-cost-fill--unknown { background: #555; }
</style>
</head>
<body>
<h1>
  <span>ACC · Performance</span>
  <button id="acc-refresh"
    style="background:#444; color:white; border:0; padding:4px 10px;
           border-radius:3px; cursor:pointer; font-size:0.82rem">Refresh</button>
</h1>
<div class="meta" id="acc-meta">connecting…</div>

<div id="acc-latency"></div>

<div class="acc-section">
  <h2>Per-agent state</h2>
  <div id="acc-agents"><div class="acc-empty">awaiting heartbeats…</div></div>
</div>

<div class="acc-section">
  <h2>Capability stats — per skill / MCP target</h2>
  <div id="acc-capabilities"><div class="acc-empty">awaiting invocations…</div></div>
</div>

<div class="acc-section">
  <h2>Plan-level token usage</h2>
  <div id="acc-costs"><div class="acc-empty">awaiting plan cost rollups…</div></div>
</div>

<script>
  const vscode = acquireVsCodeApi ? acquireVsCodeApi() : null;
  const post = (msg) => vscode ? vscode.postMessage(msg) : window.parent?.postMessage(msg, '*');

  document.getElementById('acc-refresh').addEventListener('click', () => {
    post({ type: 'refresh' });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'snapshot') {
      const h = msg.html || {};
      setHtml('acc-latency',      h.latency      || '');
      setHtml('acc-agents',       h.agents       || '');
      setHtml('acc-capabilities', h.capabilities || '');
      setHtml('acc-costs',        h.costs        || '');
    } else if (msg.type === 'meta') {
      const meta = document.getElementById('acc-meta');
      if (msg.connected) {
        meta.textContent = 'Collective: ' + msg.cid + ' · NATS: ' + msg.natsUrl + ' · live';
        meta.className = 'meta';
      } else {
        meta.textContent = 'Collective: ' + msg.cid + ' · NATS: ' + msg.natsUrl
          + ' · ' + (msg.message || 'not connected');
        meta.className = 'meta meta--bad';
      }
    }
  });

  function setHtml(id, html) {
    document.getElementById(id).innerHTML = html;
  }
</script>
</body>
</html>`;
}
