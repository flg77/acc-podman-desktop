/**
 * Kaiden import panel.
 *
 * Detects `<workspace>/.kaiden/workspace.json` (or accepts pasted
 * JSON), lists its entries, and lets the operator import each one
 * into ACC's `mcps/` tree with operator-supplied risk_level +
 * allowed_tools.
 *
 * One-way only: secret values are stripped at import; only the
 * NAMES are surfaced for the operator to wire into deploy/.env.
 *
 * Bidirectional message protocol:
 *   webview → host:
 *     { type: 'detect' }
 *     { type: 'parsePaste', text: string }
 *     { type: 'import', entry: KaidenEntry, riskLevel: string,
 *       allowedTools: string[], manifestName?: string }
 *   host → webview:
 *     { type: 'data',     entries: KaidenEntry[], sourcePath?: string,
 *                          source: 'detect' | 'paste',
 *                          reason?: string }
 *     { type: 'imported', path: string, name: string }
 *     { type: 'error',    message: string }
 */

import * as extensionApi from '@podman-desktop/api';

import type { AccPaths } from '../core/paths';
import type { Logger } from '../core/logger';
import {
  discoverKaidenWorkspace,
  parseKaidenWorkspace,
  type KaidenEntry,
} from './discovery';
import {
  importEntry,
  RISK_LEVELS,
  type RiskLevel,
} from './import';


export function registerKaidenPanel(
  paths: AccPaths | undefined,
  log: Logger,
): extensionApi.Disposable[] {
  let webview: extensionApi.WebviewPanel | undefined;

  const showCommand = extensionApi.commands.registerCommand(
    'acc.kaiden.show',
    async () => {
      try {
        webview = await openPanel(webview, paths, log);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        log.error(`kaiden.show failed: ${m}`);
        extensionApi.window.showErrorMessage(
          `ACC Kaiden import failed to open: ${m}`,
        );
      }
    },
  );

  return [
    showCommand,
    {
      dispose: () => {
        if (webview !== undefined) {
          try {
            webview.dispose();
          } catch {
            // best-effort
          }
        }
      },
    },
  ];
}


async function openPanel(
  existing: extensionApi.WebviewPanel | undefined,
  paths: AccPaths | undefined,
  log: Logger,
): Promise<extensionApi.WebviewPanel> {
  if (existing !== undefined) {
    try {
      existing.reveal();
      await detectAndPost(existing, paths, log);
      return existing;
    } catch {
      // disposed externally — fall through.
    }
  }

  const panel = extensionApi.window.createWebviewPanel(
    'acc.kaiden',
    'ACC Kaiden Import',
  );
  panel.webview.html = renderHtml();

  panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) {
      return;
    }
    const msg = raw as Record<string, unknown>;
    const type = String(msg['type'] ?? '');

    if (type === 'detect') {
      await detectAndPost(panel, paths, log);
    } else if (type === 'parsePaste') {
      const text = String(msg['text'] ?? '');
      const entries = parseKaidenWorkspace(text);
      await postSafe(panel, {
        type: 'data',
        source: 'paste',
        entries,
        sourcePath: undefined,
        reason: entries.length === 0
          ? 'Pasted JSON parsed but no entries were found.  Expected `mcp.commands[]` and/or `mcp.servers[]`.'
          : undefined,
      });
    } else if (type === 'import') {
      if (paths === undefined) {
        await postSafe(panel, {
          type: 'error',
          message:
            'ACC repo not configured.  Set "acc.repoPath" before importing.',
        });
        return;
      }
      const entry = msg['entry'] as KaidenEntry | undefined;
      if (
        entry === undefined ||
        typeof entry.name !== 'string' ||
        (entry.transport !== 'stdio' && entry.transport !== 'sse')
      ) {
        await postSafe(panel, {
          type: 'error',
          message: 'Malformed entry payload.',
        });
        return;
      }
      const riskLevel = String(msg['riskLevel'] ?? '') as RiskLevel;
      if (!RISK_LEVELS.includes(riskLevel)) {
        await postSafe(panel, {
          type: 'error',
          message: `Risk level must be one of ${RISK_LEVELS.join(' / ')}.`,
        });
        return;
      }
      const allowedToolsRaw = msg['allowedTools'];
      const allowedTools = Array.isArray(allowedToolsRaw)
        ? (allowedToolsRaw as unknown[])
            .map((x) => String(x))
            .filter((s) => s.trim().length > 0)
        : [];
      const manifestName = msg['manifestName']
        ? String(msg['manifestName'])
        : undefined;

      const result = await importEntry(paths.repoPath, entry, {
        riskLevel,
        allowedTools,
        manifestName,
      });
      if (result.ok) {
        log.info(`kaiden: imported ${entry.name} → ${result.path}`);
        await postSafe(panel, {
          type: 'imported',
          path: result.path,
          name: manifestName ?? entry.name,
        });
      } else {
        log.error(`kaiden: import failed: ${result.reason}`);
        await postSafe(panel, {
          type: 'error',
          message: `Import failed: ${result.reason}`,
        });
      }
    }
  });

  await detectAndPost(panel, paths, log);
  return panel;
}


async function detectAndPost(
  panel: extensionApi.WebviewPanel,
  paths: AccPaths | undefined,
  log: Logger,
): Promise<void> {
  const config = extensionApi.configuration.getConfiguration('acc');
  const override = config.get<string>('kaidenWorkspacePath') ?? '';
  const result = await discoverKaidenWorkspace({
    override: override.trim() || undefined,
    repoRoot: paths?.repoPath,
  });
  log.info(
    `kaiden: discovery source=${result.sourcePath ?? 'none'} count=${result.entries.length}`,
  );
  await postSafe(panel, {
    type: 'data',
    source: 'detect',
    entries: result.entries,
    sourcePath: result.sourcePath,
    reason: result.reason,
  });
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


function renderHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ACC Kaiden Import</title>
<style>
  body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         padding: 1rem; background: #1a1a2e; color: #eee; margin: 0; }
  h1 { font-size: 1.1rem; margin: 0 0 0.5rem 0; display: flex;
       align-items: center; gap: 0.75rem; }
  h2 { font-size: 0.95rem; margin: 1rem 0 0.4rem 0; color: #aaa;
       text-transform: uppercase; letter-spacing: 0.05em; }
  p { font-size: 0.85rem; color: #aaa; margin: 0 0 0.75rem 0; }
  .tabs { display: flex; gap: 0.25rem; margin-bottom: 0.75rem;
          border-bottom: 1px solid #333; }
  .tab { padding: 0.4rem 1rem; cursor: pointer; color: #aaa;
         border-bottom: 2px solid transparent; }
  .tab--active { color: #4a90e2; border-bottom-color: #4a90e2; }
  .pane { display: none; }
  .pane--active { display: block; }
  .meta { font-size: 0.8rem; color: #888; margin-bottom: 0.5rem; }
  textarea { width: 100%; min-height: 14rem; box-sizing: border-box;
             background: #15152a; color: #eee; border: 1px solid #444;
             font-family: ui-monospace, "Consolas", monospace;
             font-size: 0.82rem; padding: 0.5rem; }
  input[type=text], select { background: #15152a; color: #eee;
                              border: 1px solid #444; padding: 4px 8px;
                              font: inherit; font-size: 0.82rem; }
  button { background: #4a90e2; color: white; border: 0; padding: 5px 12px;
           border-radius: 3px; cursor: pointer; font: inherit; font-size: 0.85rem; }
  button:hover { background: #5aa0f2; }
  button.secondary { background: #444; }
  button.secondary:hover { background: #555; }
  .acc-card { background: #232342; border-radius: 4px;
              padding: 0.75rem 1rem; margin-bottom: 0.75rem; }
  .acc-card-head { display: flex; align-items: center; gap: 0.5rem;
                    flex-wrap: wrap; margin-bottom: 0.5rem; }
  .acc-card-name { font-weight: 600; }
  .acc-pill { font-size: 0.72rem; padding: 1px 6px; border-radius: 999px;
              background: #444; color: #ddd; }
  .acc-pill--stdio { background: #1565c0; color: #fff; }
  .acc-pill--sse   { background: #6a1b9a; color: #fff; }
  .acc-form { display: grid; grid-template-columns: max-content 1fr;
              gap: 0.4rem 0.75rem; margin-top: 0.5rem; align-items: center; }
  .acc-form label { color: #aaa; font-size: 0.82rem; }
  .acc-secrets { font-size: 0.8rem; color: #ffb74d; margin-top: 0.5rem; }
  .acc-empty { color: #888; font-style: italic; padding: 1rem;
               background: #232342; border-radius: 4px; }
  .acc-error { color: #ef5350; padding: 0.5rem 1rem; background: #3d1f1f;
               border-left: 3px solid #ef5350; border-radius: 3px;
               margin-bottom: 0.75rem; font-size: 0.85rem; }
  .acc-toast { position: fixed; bottom: 1rem; right: 1rem;
               background: #1f3d2c; border-left: 3px solid #4caf50;
               padding: 0.5rem 1rem; border-radius: 3px;
               opacity: 0; transition: opacity 0.3s; }
  .acc-toast--visible { opacity: 1; }
  code { background: #15152a; padding: 1px 4px; border-radius: 3px;
         font-size: 0.85em; }
  .acc-banner { background: #1c2530; padding: 0.6rem 0.85rem; border-radius: 4px;
                 border-left: 3px solid #4a90e2; font-size: 0.82rem;
                 color: #ccc; margin-bottom: 0.75rem; }
</style>
</head>
<body>
<h1>
  <span>ACC · Kaiden Import</span>
  <button class="secondary" id="acc-detect">Re-detect</button>
</h1>
<div class="acc-banner">
  <strong>One-way import.</strong>  Secret values (env, headers) are
  dropped — only their NAMES are surfaced.  Operator must set
  <code>risk_level</code> and <code>allowed_tools</code> per entry; ACC
  never reverse-trusts Kaiden's loose model.
</div>
<div class="meta" id="acc-meta">scanning…</div>
<div class="acc-error" id="acc-error" style="display:none"></div>

<div class="tabs">
  <div class="tab tab--active" data-tab="detect">Detected workspace</div>
  <div class="tab" data-tab="paste">Paste JSON</div>
</div>

<div class="pane pane--active" data-pane="detect">
  <div id="acc-list-detect"><div class="acc-empty">scanning…</div></div>
</div>

<div class="pane" data-pane="paste">
  <p>Paste the contents of a Kaiden <code>workspace.json</code> file
     to import its <code>mcp.commands[]</code> and <code>mcp.servers[]</code>
     entries.  Useful when the workspace lives outside the configured
     repo path.</p>
  <textarea id="acc-paste-text"
    placeholder='{ "mcp": { "commands": [...], "servers": [...] } }'></textarea>
  <div style="margin-top: 0.5rem;">
    <button id="acc-paste-go">Parse</button>
  </div>
  <div id="acc-list-paste" style="margin-top:1rem;"></div>
</div>

<div class="acc-toast" id="acc-toast"></div>

<script>
  const vscode = acquireVsCodeApi ? acquireVsCodeApi() : null;
  const post = (msg) => vscode ? vscode.postMessage(msg) : window.parent?.postMessage(msg, '*');

  // Tabs
  document.querySelectorAll('.tab').forEach((el) => {
    el.addEventListener('click', () => {
      const t = el.dataset.tab;
      document.querySelectorAll('.tab').forEach((x) =>
        x.classList.toggle('tab--active', x.dataset.tab === t));
      document.querySelectorAll('.pane').forEach((p) =>
        p.classList.toggle('pane--active', p.dataset.pane === t));
    });
  });

  document.getElementById('acc-detect').addEventListener('click', () => {
    setMeta('scanning…');
    post({ type: 'detect' });
  });
  document.getElementById('acc-paste-go').addEventListener('click', () => {
    const text = document.getElementById('acc-paste-text').value;
    if (!text.trim()) {
      showToast('Paste workspace.json content first.');
      return;
    }
    post({ type: 'parsePaste', text });
  });

  // Per-source caches so import-button clicks rebuild a fresh entry
  // payload locally without re-asking the host.
  let lastDetect = [];
  let lastPaste = [];

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'data') {
      hideError();
      const entries = Array.isArray(msg.entries) ? msg.entries : [];
      if (msg.source === 'paste') {
        lastPaste = entries;
        renderEntries('acc-list-paste', entries, msg.reason);
      } else {
        lastDetect = entries;
        renderEntries('acc-list-detect', entries, msg.reason);
        setMeta(msg.sourcePath
          ? 'Loaded ' + entries.length + ' entries from ' + msg.sourcePath
          : (msg.reason || 'No workspace detected.'));
      }
    } else if (msg.type === 'imported') {
      showToast('Wrote ' + msg.path);
    } else if (msg.type === 'error') {
      showError(msg.message || 'Unknown error');
    }
  });

  function renderEntries(elId, entries, reason) {
    const el = document.getElementById(elId);
    if (!entries || entries.length === 0) {
      el.innerHTML = '<div class="acc-empty">' +
        esc(reason || 'No entries.') + '</div>';
      return;
    }
    el.innerHTML = '';
    entries.forEach((entry, idx) => {
      const card = document.createElement('div');
      card.className = 'acc-card';
      const idPrefix = elId + '-' + idx;
      const header = '<div class="acc-card-head">' +
        '<span class="acc-card-name">' + esc(entry.name) + '</span>' +
        '<span class="acc-pill acc-pill--' + esc(entry.transport) + '">' +
          esc(entry.transport) + '</span>' +
        (entry.transport === 'stdio'
          ? '<code>' + esc((entry.command || []).join(' ')) + '</code>'
          : '<code>' + esc(entry.url || '') + '</code>') +
        '</div>';
      const secretCount =
        (entry.env_var_names || []).length + (entry.header_names || []).length;
      const secrets = secretCount > 0
        ? '<div class="acc-secrets">Secrets stripped — wire these names ' +
          'into deploy/.env yourself: ' +
          (entry.env_var_names || []).map((n) =>
            '<code>env: ' + esc(n) + '</code>').join(' ') +
          ' ' +
          (entry.header_names || []).map((n) =>
            '<code>hdr: ' + esc(n) + '</code>').join(' ') +
          '</div>'
        : '';
      const form = '<div class="acc-form">' +
        '<label for="risk-' + idPrefix + '">Risk level</label>' +
        '<select id="risk-' + idPrefix + '">' +
          '<option value="LOW">LOW</option>' +
          '<option value="MEDIUM" selected>MEDIUM</option>' +
          '<option value="HIGH">HIGH</option>' +
          '<option value="CRITICAL">CRITICAL</option>' +
        '</select>' +
        '<label for="tools-' + idPrefix + '">Allowed tools (comma)</label>' +
        '<input type="text" id="tools-' + idPrefix + '" placeholder="tool_a, tool_b">' +
        '<label for="name-' + idPrefix + '">Manifest name</label>' +
        '<input type="text" id="name-' + idPrefix + '" value="' +
          esc(slugify(entry.name)) + '">' +
        '<span></span><div><button data-import="' + idx + '" data-source="' +
          (elId === 'acc-list-detect' ? 'detect' : 'paste') + '">Import</button></div>' +
        '</div>';
      card.innerHTML = header + secrets + form;
      el.appendChild(card);
    });
    el.querySelectorAll('button[data-import]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.import);
        const source = btn.dataset.source;
        const sink = source === 'paste' ? lastPaste : lastDetect;
        const entry = sink[idx];
        if (!entry) return;
        const idPrefix = (source === 'paste' ? 'acc-list-paste' : 'acc-list-detect') + '-' + idx;
        const risk = document.getElementById('risk-' + idPrefix).value;
        const tools = document.getElementById('tools-' + idPrefix).value
          .split(',').map((s) => s.trim()).filter(Boolean);
        const manifestName = document.getElementById('name-' + idPrefix).value.trim();
        post({
          type: 'import', entry, riskLevel: risk,
          allowedTools: tools, manifestName: manifestName || undefined,
        });
      });
    });
  }

  function slugify(s) {
    return String(s || '').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
  function setMeta(text) {
    document.getElementById('acc-meta').textContent = text;
  }
  function showError(msg) {
    const el = document.getElementById('acc-error');
    el.textContent = msg;
    el.style.display = 'block';
  }
  function hideError() {
    document.getElementById('acc-error').style.display = 'none';
  }
  function showToast(text) {
    const t = document.getElementById('acc-toast');
    t.textContent = text;
    t.classList.add('acc-toast--visible');
    setTimeout(() => t.classList.remove('acc-toast--visible'), 2500);
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
</script>
</body>
</html>`;
}
