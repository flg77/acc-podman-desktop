/**
 * Collectives picker — webview that lists the runtime repo's
 * `collectives/` agentset presets and lets the operator preview or
 * apply one without leaving Podman Desktop.
 *
 * Each preset card shows the declared agents (role × cluster ×
 * model × replicas) + required family packs, with two actions that
 * shell `acc-deploy.sh`:
 *   - Dry-run → `apply --dry-run <name>`  (preview the reconcile diff)
 *   - Apply   → `apply <name>`            (synthesize + bring up the agentset)
 *
 * Read-only on the filesystem (authoring presets stays in the
 * operator's editor); the only side effect is the `apply` the
 * operator explicitly clicks.  Mirrors the examples panel's
 * message-passing + live-tail shape.
 *
 * Bidirectional message protocol with the webview:
 *   webview → host:
 *     { type: 'apply',   name: '<preset>' }
 *     { type: 'dry-run', name: '<preset>' }
 *     { type: 'kill',    name: '<preset>' }
 *     { type: 'refresh' }
 *   host → webview:
 *     { type: 'log',   name: '<preset>', kind: 'stdout'|'stderr', text }
 *     { type: 'state', name: '<preset>', running: boolean }
 */

import * as extensionApi from '@podman-desktop/api';

import type { AccPaths } from '../core/paths';
import type { Logger } from '../core/logger';
import { runScript, type RunnerHandle } from '../examples/runner';
import { loadCollectives, type CollectiveSummary } from './loader';


interface PanelState {
  paths: AccPaths | undefined;
  log: Logger;
  webview: extensionApi.WebviewPanel | undefined;
  /** Per-preset active runner — only one acc-deploy process per name. */
  runners: Map<string, RunnerHandle>;
}


export function registerCollectivesPanel(
  paths: AccPaths | undefined,
  log: Logger,
): extensionApi.Disposable[] {
  const state: PanelState = {
    paths,
    log,
    webview: undefined,
    runners: new Map(),
  };

  const showCommand = extensionApi.commands.registerCommand(
    'acc.collectives.show',
    async () => {
      try {
        await openPanel(state);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`collectives.show failed: ${msg}`);
        extensionApi.window.showErrorMessage(
          `ACC collectives panel failed to open: ${msg}`,
        );
      }
    },
  );

  return [
    showCommand,
    {
      dispose: () => {
        for (const r of state.runners.values()) {
          r.kill();
        }
        state.runners.clear();
        if (state.webview !== undefined) {
          try {
            state.webview.dispose();
          } catch {
            // best-effort
          }
        }
      },
    },
  ];
}


async function openPanel(state: PanelState): Promise<void> {
  if (state.webview !== undefined) {
    try {
      state.webview.reveal();
      return;
    } catch {
      state.webview = undefined;
    }
  }

  const panel = extensionApi.window.createWebviewPanel(
    'acc.collectives',
    'ACC Collectives',
  );
  state.webview = panel;
  panel.webview.html = await renderHtml(state);

  panel.onDidDispose(() => {
    state.webview = undefined;
    for (const r of state.runners.values()) {
      r.kill();
    }
    state.runners.clear();
  });

  panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) {
      return;
    }
    const msg = raw as Record<string, unknown>;
    const type = String(msg['type'] ?? '');

    try {
      if (type === 'refresh') {
        if (state.webview !== undefined) {
          state.webview.webview.html = await renderHtml(state);
        }
        return;
      }
      const name = String(msg['name'] ?? '');
      if (name === '') {
        return;
      }
      if (type === 'apply') {
        await dispatchApply(state, name, false);
      } else if (type === 'dry-run') {
        await dispatchApply(state, name, true);
      } else if (type === 'kill') {
        state.runners.get(name)?.kill();
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      state.log.error(`collectives panel: ${type}: ${errMsg}`);
      void postLog(state, String(msg['name'] ?? ''), 'stderr', `\nERROR: ${errMsg}\n`);
    }
  });
}


async function dispatchApply(
  state: PanelState,
  name: string,
  dryRun: boolean,
): Promise<void> {
  if (state.paths === undefined) {
    void postLog(state, name, 'stderr',
      'ACC repo not configured.  Set "acc.repoPath" in settings.\n');
    return;
  }
  if (state.runners.get(name)?.isRunning()) {
    void postLog(state, name, 'stderr',
      'A run for this preset is already in progress.\n');
    return;
  }

  const args = dryRun ? ['apply', '--dry-run', name] : ['apply', name];

  void postState(state, name, true);
  void postLog(state, name, 'stdout',
    `▶ ${state.paths.deployScript} ${args.join(' ')}\n`);

  const handle = runScript({
    command: state.paths.deployScript,
    args,
    cwd: state.paths.repoPath,
    onChunk: (kind, text) => void postLog(state, name, kind, text),
  });
  state.runners.set(name, handle);
  const code = await handle.promise;

  void postState(state, name, false);
  void postLog(state, name, 'stdout', `\n[exit ${code}]\n`);
}


// ---------------------------------------------------------------------------
// Webview message senders
// ---------------------------------------------------------------------------


async function postLog(
  state: PanelState,
  name: string,
  kind: 'stdout' | 'stderr',
  text: string,
): Promise<void> {
  if (state.webview === undefined) {
    return;
  }
  try {
    await state.webview.webview.postMessage({ type: 'log', name, kind, text });
  } catch {
    // Webview may have closed mid-write; runner keeps going.
  }
}


async function postState(
  state: PanelState,
  name: string,
  running: boolean,
): Promise<void> {
  if (state.webview === undefined) {
    return;
  }
  try {
    await state.webview.webview.postMessage({ type: 'state', name, running });
  } catch {
    // best-effort
  }
}


// ---------------------------------------------------------------------------
// HTML render
// ---------------------------------------------------------------------------


async function renderHtml(state: PanelState): Promise<string> {
  let body: string;
  if (state.paths === undefined) {
    body =
      '<p class="acc-empty">ACC repo not configured.  Set ' +
      '<code>acc.repoPath</code> in settings to your agentic-cell-corpus checkout.</p>';
  } else {
    const collectives = await loadCollectives(state.paths.repoPath);
    body = collectives.length === 0
      ? '<p class="acc-empty">No presets found under <code>collectives/</code>.</p>'
      : collectives.map(renderCard).join('\n');
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ACC Collectives</title>
<style>
  body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         padding: 1rem; background: #1a1a2e; color: #eee; margin: 0; }
  h1   { font-size: 1.1rem; margin: 0 0 0.25rem 0; }
  .acc-intro { color: #aaa; margin: 0 0 1rem 0; }
  .acc-empty { color: #aaa; }
  .acc-card { background: #232342; border-left: 3px solid #8a6fd4;
              border-radius: 4px; padding: 1rem; margin-bottom: 1rem; }
  .acc-card h2 { font-size: 1rem; margin: 0 0 0.2rem 0; }
  .acc-card h2 code { font-size: 0.85rem; color: #b9a6ee; }
  .acc-card p  { color: #aaa; margin: 0 0 0.5rem 0; }
  .acc-meta { color: #8fb0d8; font-size: 0.82rem; margin: 0 0 0.5rem 0; }
  .acc-pkgs { font-size: 0.8rem; color: #c9b58a; margin: 0 0 0.5rem 0; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 0.6rem 0;
          font-size: 0.82rem; }
  th, td { text-align: left; padding: 2px 10px 2px 0; color: #ccc;
           border-bottom: 1px solid #2e2e52; white-space: nowrap; }
  th { color: #888; font-weight: 600; }
  .acc-actions { display: flex; gap: 0.5rem; flex-wrap: wrap;
                 align-items: center; margin-bottom: 0.4rem; }
  button { background: #8a6fd4; color: white; border: 0; padding: 6px 14px;
           border-radius: 3px; cursor: pointer; font: inherit; }
  button:hover { background: #9a7fe4; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.acc-secondary { background: #444; }
  button.acc-secondary:hover { background: #555; }
  button.acc-danger { background: #ef5350; }
  .acc-status { display: inline-block; min-width: 9ch; font-size: 0.85rem;
                color: #888; padding-left: 0.5rem; }
  .acc-status--running { color: #ffd54f; }
  .acc-log { background: #0e0e1c; padding: 0.5rem 0.75rem;
             font: 11px/1.4 ui-monospace, SFMono-Regular, monospace;
             white-space: pre-wrap; word-break: break-word;
             max-height: 12rem; overflow-y: auto; border-radius: 3px;
             margin-top: 0.5rem; }
  .acc-log .acc-log-stderr { color: #ffab91; }
</style>
</head>
<body>
<h1>ACC Collectives</h1>
<p class="acc-intro">Agentset presets under <code>collectives/</code>.
  <strong>Dry-run</strong> previews the reconcile diff; <strong>Apply</strong>
  synthesizes the agents and brings them up via
  <code>acc-deploy.sh apply &lt;name&gt;</code>.</p>
${body}
<script>
  const vscode = acquireVsCodeApi ? acquireVsCodeApi() : null;
  const post = (msg) => vscode ? vscode.postMessage(msg) : window.parent?.postMessage(msg, '*');

  const cards = {};
  document.querySelectorAll('[data-collective]').forEach((el) => {
    const name = el.dataset.collective;
    cards[name] = {
      el,
      logEl: el.querySelector('.acc-log'),
      statusEl: el.querySelector('.acc-status'),
      applyBtn: el.querySelector('button[data-action="apply"]'),
      dryBtn: el.querySelector('button[data-action="dry-run"]'),
      killBtn: el.querySelector('button[data-action="kill"]'),
    };
    cards[name].applyBtn.addEventListener('click', () =>
      post({ type: 'apply', name }));
    cards[name].dryBtn.addEventListener('click', () =>
      post({ type: 'dry-run', name }));
    cards[name].killBtn?.addEventListener('click', () =>
      post({ type: 'kill', name }));
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    const card = cards[msg.name];
    if (!card) return;

    if (msg.type === 'log') {
      const span = document.createElement('span');
      if (msg.kind === 'stderr') span.className = 'acc-log-stderr';
      span.textContent = msg.text;
      card.logEl.appendChild(span);
      card.logEl.scrollTop = card.logEl.scrollHeight;
    } else if (msg.type === 'state') {
      card.statusEl.textContent = msg.running ? '● running' : '';
      card.statusEl.className = 'acc-status' + (msg.running ? ' acc-status--running' : '');
      card.applyBtn.disabled = msg.running;
      card.dryBtn.disabled = msg.running;
      if (card.killBtn) card.killBtn.disabled = !msg.running;
    }
  });
</script>
</body>
</html>`;
}


function renderCard(c: CollectiveSummary): string {
  const clusterSummary = c.clusters.length > 0
    ? `${c.clusters.length} cluster${c.clusters.length === 1 ? '' : 's'} (${c.clusters.map(esc).join(', ')})`
    : 'no clusters declared';
  const meta =
    `${c.agents.length} role${c.agents.length === 1 ? '' : 's'} · ` +
    `${c.totalReplicas} replica${c.totalReplicas === 1 ? '' : 's'} · ` +
    `${clusterSummary} · collective_id <code>${esc(c.collectiveId || '—')}</code>`;

  const pkgs = c.requiredPackages.length > 0
    ? `<p class="acc-pkgs">Required packs: ${c.requiredPackages.map((p) => esc(p)).join(', ')}</p>`
    : '';

  const rows = c.agents.map((a) =>
    `<tr><td>${esc(a.role)}</td><td>${a.replicas}</td>` +
    `<td>${esc(a.cluster || '—')}</td><td>${esc(a.model || 'default')}</td></tr>`,
  ).join('');
  const table = c.agents.length > 0
    ? `<table><thead><tr><th>role</th><th>×</th><th>cluster</th><th>model</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`
    : '';

  return `
<section class="acc-card" data-collective="${esc(c.name)}">
  <h2>${esc(c.name)} <code>${esc(c.file)}</code></h2>
  <p>${esc(c.blurb)}</p>
  <p class="acc-meta">${meta}</p>
  ${pkgs}
  ${table}
  <div class="acc-actions">
    <button data-action="dry-run" class="acc-secondary">Dry-run</button>
    <button data-action="apply">Apply</button>
    <button data-action="kill" class="acc-danger" disabled>Stop</button>
    <span class="acc-status"></span>
  </div>
  <pre class="acc-log"></pre>
</section>`;
}


function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
