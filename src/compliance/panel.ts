/**
 * Compliance dashboard panel.
 *
 * Subscribes to `acc.{cid}.>` (HEARTBEAT + EVAL_OUTCOME +
 * ALERT_ESCALATE) via the existing decodeFrame() shape, folds into
 * a ComplianceAggregator, and pushes snapshot fragments into the
 * webview on every change.
 *
 * Approve / Reject buttons publish `OVERSIGHT_DECISION` on
 * `acc.{cid}.oversight.{oversight_id}` — wire-format parity with
 * the TUI's `_OversightAction` handler.
 *
 * Bidirectional message protocol with the webview:
 *   webview → host:
 *     { type: 'oversight', decision: 'approve' | 'reject',
 *       oversight_id: string, reason?: string }
 *     { type: 'refresh' }
 *   host → webview:
 *     { type: 'snapshot', html: { health, owasp, triggers,
 *                                 oversight, log } }
 *     { type: 'meta',     cid: string, natsUrl: string,
 *                          connected: boolean, message?: string }
 *     { type: 'toast',    message: string }
 *     { type: 'error',    message: string }
 */

import * as extensionApi from '@podman-desktop/api';
import { connect, type NatsConnection, type Subscription } from 'nats';
import { encode as msgpackEncode } from '@msgpack/msgpack';

import type { AccPaths } from '../core/paths';
import type { Logger } from '../core/logger';
import { panicRegistry } from '../core/panic';
import { ComplianceAggregator } from './aggregator';
import { decodeFrame } from '../cluster/subscriber';
import {
  renderAgentTriggers,
  renderHealth,
  renderOversightQueue,
  renderOwaspTable,
  renderViolationLog,
} from './renderer';


interface PanelState {
  panel: extensionApi.WebviewPanel;
  aggregator: ComplianceAggregator;
  nc: NatsConnection | undefined;
  sub: Subscription | undefined;
  cid: string;
  natsUrl: string;
  refreshScheduled: boolean;
  panicHandle: { unregister: () => void } | undefined;
}


export function registerCompliancePanel(
  _paths: AccPaths | undefined,
  log: Logger,
): extensionApi.Disposable[] {
  let state: PanelState | undefined;

  const showCommand = extensionApi.commands.registerCommand(
    'acc.compliance.show',
    async () => {
      try {
        state = await openPanel(state, log);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`compliance.show failed: ${msg}`);
        extensionApi.window.showErrorMessage(
          `ACC compliance panel failed to open: ${msg}`,
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
    'acc.compliance',
    'ACC Compliance',
  );
  panel.webview.html = renderInitialHtml();

  const state: PanelState = {
    panel,
    aggregator: new ComplianceAggregator(),
    nc: undefined,
    sub: undefined,
    cid,
    natsUrl,
    refreshScheduled: false,
    panicHandle: undefined,
  };
  state.panicHandle = panicRegistry.register({
    label: `compliance(${cid})`,
    dispose: () => teardown(state),
  });

  panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) {
      return;
    }
    const msg = raw as Record<string, unknown>;
    const type = String(msg['type'] ?? '');
    if (type === 'refresh') {
      paint(state);
    } else if (type === 'oversight') {
      const decision = String(msg['decision'] ?? '');
      const oid = String(msg['oversight_id'] ?? '');
      const reason = msg['reason'] === undefined ? '' : String(msg['reason']);
      if (!oid || (decision !== 'approve' && decision !== 'reject')) {
        return;
      }
      try {
        await publishOversightDecision(state, decision, oid, reason);
        await postSafe(panel, {
          type: 'toast',
          message: `${decision === 'approve' ? 'Approved' : 'Rejected'} ${oid.slice(0, 8)}`,
        });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        log.error(`compliance: publish OVERSIGHT_DECISION failed: ${m}`);
        await postSafe(panel, {
          type: 'error',
          message: `Failed to publish decision: ${m}`,
        });
      }
    }
  });

  panel.onDidDispose(() => {
    void teardown(state);
  });

  // Connect + subscribe.  Best-effort: if NATS is unreachable we
  // still leave the panel up so the operator sees the meta line.
  try {
    state.nc = await connect({ servers: natsUrl });
    log.info(`compliance: connected to ${natsUrl}`);
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
    log.warn(`compliance: NATS connect failed: ${m}`);
    await postSafe(panel, {
      type: 'meta',
      cid,
      natsUrl,
      connected: false,
      message: `NATS connect failed: ${m}`,
    });
  }

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
        `compliance: ingest failed: ${
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
      health: renderHealth(snap),
      owasp: renderOwaspTable(snap),
      triggers: renderAgentTriggers(snap),
      oversight: renderOversightQueue(snap),
      log: renderViolationLog(snap),
    },
  });
}


async function publishOversightDecision(
  state: PanelState,
  decision: 'approve' | 'reject',
  oversightId: string,
  reason: string,
): Promise<void> {
  if (state.nc === undefined) {
    throw new Error('NATS not connected');
  }
  const subject = `acc.${state.cid}.oversight.${oversightId}`;
  const payload = {
    signal_type: 'OVERSIGHT_DECISION',
    oversight_id: oversightId,
    decision: decision === 'approve' ? 'APPROVE' : 'REJECT',
    approver_id: 'pd-extension',
    reason,
    ts: Date.now() / 1000,
    collective_id: state.cid,
  };
  // Wire format parity: msgpack(<utf-8 JSON bytes>).
  const innerJson = JSON.stringify(payload);
  const innerBytes = new TextEncoder().encode(innerJson);
  const wrapped = msgpackEncode(innerBytes);
  state.nc.publish(subject, wrapped);
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


// ---------------------------------------------------------------------------
// Initial HTML — single shot.  Subsequent updates flow via postMessage.
// ---------------------------------------------------------------------------


function renderInitialHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ACC Compliance</title>
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
  .acc-grid { display: grid; gap: 0.75rem;
              grid-template-columns: 1fr 1fr; }
  @media (max-width: 900px) { .acc-grid { grid-template-columns: 1fr; } }
  .acc-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  .acc-table th, .acc-table td { padding: 0.3rem 0.5rem; text-align: left;
                                  border-bottom: 1px solid #2c2c54; }
  .acc-table th { color: #aaa; font-weight: 500; }
  .acc-empty { color: #888; font-style: italic; }
  .acc-warn { color: #ffb74d; font-weight: 600; }
  .acc-pill { font-size: 0.75rem; padding: 1px 6px; border-radius: 999px;
              background: #444; color: #ddd; }
  .acc-pill--HIGH { background: #b71c1c; color: #fff; }
  .acc-pill--MEDIUM { background: #ef6c00; color: #fff; }
  .acc-pill--LOW { background: #2e7d32; color: #fff; }
  .acc-pill--CRITICAL { background: #4a148c; color: #fff; }
  .acc-owasp-row--zero td { color: #555; }
  .acc-owasp-count { text-align: right; font-family: ui-monospace, "Consolas", monospace; }
  .acc-health { display: flex; align-items: center; gap: 0.75rem;
                padding: 0.5rem 0.75rem; border-radius: 4px;
                background: #232342; margin-bottom: 0.75rem; }
  .acc-health-bar { flex: 1; height: 8px; background: #15152a;
                    border-radius: 4px; overflow: hidden; }
  .acc-health-fill { display: block; height: 100%; }
  .acc-health--good .acc-health-fill { background: #4caf50; }
  .acc-health--warn .acc-health-fill { background: #ffb74d; }
  .acc-health--bad  .acc-health-fill { background: #ef6c00; }
  .acc-health--crit .acc-health-fill { background: #b71c1c; }
  .acc-health-value { font-family: ui-monospace, "Consolas", monospace;
                       font-weight: 600; min-width: 4ch; text-align: right; }
  .acc-oversight-actions { display: flex; gap: 0.4rem; align-items: center; }
  .acc-oversight-actions input { background: #15152a; color: #eee;
                                  border: 1px solid #444; padding: 3px 6px;
                                  font-size: 0.8rem; min-width: 16ch; }
  button { background: #4a90e2; color: white; border: 0; padding: 4px 10px;
           border-radius: 3px; cursor: pointer; font: inherit; font-size: 0.82rem; }
  button:hover { background: #5aa0f2; }
  button.acc-secondary { background: #b71c1c; }
  button.acc-secondary:hover { background: #c62828; }
  .acc-toast { position: fixed; bottom: 1rem; right: 1rem;
               background: #1f3d2c; border-left: 3px solid #4caf50;
               padding: 0.5rem 1rem; border-radius: 3px;
               opacity: 0; transition: opacity 0.3s; }
  .acc-toast--visible { opacity: 1; }
  .acc-toast--error { background: #3d1f1f; border-left-color: #ef5350; }
  code { background: #15152a; padding: 1px 4px; border-radius: 3px;
         font-size: 0.85em; }
</style>
</head>
<body>
<h1>
  <span>ACC · Compliance</span>
  <button class="acc-secondary" id="acc-refresh"
    style="background:#444">Refresh</button>
</h1>
<div class="meta" id="acc-meta">connecting…</div>

<div id="acc-health"></div>

<div class="acc-grid">
  <div class="acc-section">
    <h2>OWASP-LLM violations</h2>
    <div id="acc-owasp"><div class="acc-empty">awaiting heartbeats…</div></div>
  </div>
  <div class="acc-section">
    <h2>Per-agent triggers</h2>
    <div id="acc-triggers"><div class="acc-empty">awaiting heartbeats…</div></div>
  </div>
</div>

<div class="acc-section">
  <h2>Oversight queue</h2>
  <div id="acc-oversight"><div class="acc-empty">awaiting heartbeats…</div></div>
</div>

<div class="acc-section">
  <h2>Recent violation log</h2>
  <div id="acc-log"><div class="acc-empty">awaiting heartbeats…</div></div>
</div>

<div class="acc-toast" id="acc-toast"></div>

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
      setHtml('acc-health',    h.health    || '');
      setHtml('acc-owasp',     h.owasp     || '');
      setHtml('acc-triggers',  h.triggers  || '');
      setHtml('acc-oversight', h.oversight || '');
      setHtml('acc-log',       h.log       || '');
      wireOversightButtons();
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
    } else if (msg.type === 'toast') {
      showToast(msg.message || '', false);
    } else if (msg.type === 'error') {
      showToast(msg.message || '', true);
    }
  });

  function setHtml(id, html) {
    document.getElementById(id).innerHTML = html;
  }

  function wireOversightButtons() {
    const root = document.getElementById('acc-oversight');
    if (!root) return;
    root.querySelectorAll('button[data-decision]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const decision = btn.dataset.decision;
        const oid = btn.dataset.oid;
        let reason = '';
        if (decision === 'reject') {
          const inp = root.querySelector('input[data-reject-reason="' + oid + '"]');
          reason = inp ? inp.value.trim() : '';
        }
        post({ type: 'oversight', decision, oversight_id: oid, reason });
      });
    });
  }

  function showToast(text, isError) {
    const t = document.getElementById('acc-toast');
    t.textContent = text;
    t.classList.toggle('acc-toast--error', !!isError);
    t.classList.add('acc-toast--visible');
    setTimeout(() => t.classList.remove('acc-toast--visible'), 3000);
  }
</script>
</body>
</html>`;
}
