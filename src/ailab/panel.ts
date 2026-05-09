/**
 * AI Lab auto-detect panel.
 *
 * Headline cross-extension story for v0.2: discover AI Lab Model
 * Services running on the host and offer one-click "Wire to
 * deploy/.env" actions.  Falls back to manual URL entry when AI Lab
 * isn't running.
 *
 * Bidirectional message protocol:
 *   webview → host:
 *     { type: 'refresh' }
 *     { type: 'wire',     baseUrl: string, modelName?: string }
 *   host → webview:
 *     { type: 'data',     services: ModelService[],
 *                          source: 'ai-lab-api' | 'podman-ps' | 'none',
 *                          reason?: string }
 *     { type: 'wired',    path: string, baseUrl: string, modelName?: string }
 *     { type: 'error',    message: string }
 */

import * as extensionApi from '@podman-desktop/api';

import type { AccPaths } from '../core/paths';
import type { Logger } from '../core/logger';
import { discoverModelServices } from './discovery';
import { wireBaseUrl } from './wire-env';


export function registerAiLabPanel(
  paths: AccPaths | undefined,
  log: Logger,
): extensionApi.Disposable[] {
  let webview: extensionApi.WebviewPanel | undefined;

  const showCommand = extensionApi.commands.registerCommand(
    'acc.ailab.show',
    async () => {
      try {
        webview = await openPanel(webview, paths, log);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`ailab.show failed: ${msg}`);
        extensionApi.window.showErrorMessage(
          `ACC AI Lab panel failed to open: ${msg}`,
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
      await refresh(existing, log);
      return existing;
    } catch {
      // panel disposed — fall through.
    }
  }

  const panel = extensionApi.window.createWebviewPanel(
    'acc.ailab',
    'ACC AI Lab Model Services',
  );
  panel.webview.html = renderHtml();

  panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) {
      return;
    }
    const msg = raw as Record<string, unknown>;
    const type = String(msg['type'] ?? '');
    if (type === 'refresh') {
      await refresh(panel, log);
    } else if (type === 'wire') {
      const baseUrl = String(msg['baseUrl'] ?? '');
      const modelName = msg['modelName'] ? String(msg['modelName']) : undefined;
      if (!baseUrl) {
        return;
      }
      if (paths === undefined) {
        await postSafe(panel, {
          type: 'error',
          message:
            'ACC repo not configured.  Set "acc.repoPath" in settings to wire ' +
            'AI Lab into deploy/.env.',
        });
        return;
      }
      const result = await wireBaseUrl(paths.repoPath, { baseUrl, modelName });
      if (result.ok) {
        log.info(`ailab: wired ${baseUrl} → ${result.path}`);
        await postSafe(panel, {
          type: 'wired',
          path: result.path,
          baseUrl,
          modelName,
        });
      } else {
        log.error(`ailab: wire failed: ${result.reason}`);
        await postSafe(panel, {
          type: 'error',
          message: `Failed to write deploy/.env: ${result.reason}`,
        });
      }
    }
  });

  await refresh(panel, log);
  return panel;
}


async function refresh(
  panel: extensionApi.WebviewPanel,
  log: Logger,
): Promise<void> {
  const result = await discoverModelServices();
  log.info(
    `ailab: discovery source=${result.source} count=${result.services.length}`,
  );
  await postSafe(panel, {
    type: 'data',
    services: result.services,
    source: result.source,
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
<title>ACC AI Lab Model Services</title>
<style>
  body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         padding: 1rem; background: #1a1a2e; color: #eee; margin: 0; }
  h1 { font-size: 1.1rem; margin: 0 0 1rem 0; display: flex;
       align-items: center; gap: 0.75rem; }
  .acc-source { font-size: 0.75rem; padding: 2px 8px; border-radius: 999px;
                background: #2c2c54; color: #aaa; margin-left: auto; }
  .acc-card { background: #232342; border-radius: 4px; padding: 0.75rem 1rem;
              margin-bottom: 0.75rem; display: grid; grid-template-columns: 1fr auto;
              gap: 0.5rem; align-items: center; }
  .acc-card-title { font-weight: 600; }
  .acc-card-url { font-family: ui-monospace, "Consolas", monospace;
                  font-size: 0.85rem; color: #9eafe2; }
  .acc-empty { color: #888; font-style: italic; padding: 1rem;
               background: #232342; border-radius: 4px; }
  .acc-manual { background: #232342; border-radius: 4px; padding: 1rem;
                margin-top: 1rem; }
  .acc-manual h3 { margin: 0 0 0.5rem 0; font-size: 0.95rem; }
  .acc-manual input { width: 100%; padding: 5px; box-sizing: border-box;
                      background: #15152a; color: #eee; border: 1px solid #444;
                      font-family: ui-monospace, "Consolas", monospace;
                      font-size: 0.85rem; }
  .acc-manual label { display: block; margin: 0.5rem 0 0.2rem 0;
                      font-size: 0.8rem; color: #aaa; }
  button { background: #4a90e2; color: white; border: 0; padding: 5px 12px;
           border-radius: 3px; cursor: pointer; font: inherit; font-size: 0.85rem; }
  button:hover { background: #5aa0f2; }
  button.acc-secondary { background: #444; }
  button.acc-secondary:hover { background: #555; }
  .acc-error { color: #ef5350; padding: 0.5rem 1rem; background: #3d1f1f;
               border-left: 3px solid #ef5350; border-radius: 3px;
               margin-bottom: 1rem; font-size: 0.85rem; }
  .acc-toast { position: fixed; bottom: 1rem; right: 1rem;
               background: #1f3d2c; border-left: 3px solid #4caf50;
               padding: 0.5rem 1rem; border-radius: 3px;
               opacity: 0; transition: opacity 0.3s; }
  .acc-toast--visible { opacity: 1; }
  p { font-size: 0.85rem; color: #aaa; margin: 0 0 1rem 0; }
</style>
</head>
<body>
<h1>
  <span>ACC · AI Lab Model Services</span>
  <span class="acc-source" id="acc-source">scanning…</span>
  <button class="acc-secondary" id="acc-refresh">Refresh</button>
</h1>
<p>One-click wire an AI Lab inference endpoint into <code>deploy/.env</code>
   as the ACC OpenAI-compatible backend.  Falls back to manual URL entry.</p>

<div class="acc-error" id="acc-error" style="display:none"></div>
<div id="acc-list"><div class="acc-empty">scanning…</div></div>

<div class="acc-manual">
  <h3>Manual URL entry</h3>
  <label for="acc-manual-url">Base URL (must end in <code>/v1</code>)</label>
  <input id="acc-manual-url" placeholder="http://localhost:8000/v1">
  <label for="acc-manual-model">Model name (optional)</label>
  <input id="acc-manual-model" placeholder="qwen3-1.7b">
  <div style="margin-top: 0.75rem;">
    <button id="acc-manual-go">Wire to deploy/.env</button>
  </div>
</div>

<div class="acc-toast" id="acc-toast"></div>

<script>
  const vscode = acquireVsCodeApi ? acquireVsCodeApi() : null;
  const post = (msg) => vscode ? vscode.postMessage(msg) : window.parent?.postMessage(msg, '*');

  document.getElementById('acc-refresh').addEventListener('click', () => {
    setSource('scanning…');
    post({ type: 'refresh' });
  });
  document.getElementById('acc-manual-go').addEventListener('click', () => {
    const url = document.getElementById('acc-manual-url').value.trim();
    const model = document.getElementById('acc-manual-model').value.trim();
    if (!url) {
      showToast('Enter a base URL first.');
      return;
    }
    post({ type: 'wire', baseUrl: url, modelName: model || undefined });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'data') {
      hideError();
      setSource(sourceLabel(msg.source));
      renderServices(msg.services || []);
      if (msg.source === 'none' && msg.reason) {
        renderEmpty(msg.reason);
      }
    } else if (msg.type === 'error') {
      showError(msg.message || 'Unknown error');
    } else if (msg.type === 'wired') {
      showToast('Wired ' + msg.baseUrl + ' → deploy/.env');
    }
  });

  function setSource(text) {
    document.getElementById('acc-source').textContent = text;
  }
  function sourceLabel(s) {
    if (s === 'ai-lab-api') return 'via AI Lab REST API';
    if (s === 'podman-ps')  return 'via podman ps';
    return 'no AI Lab detected';
  }

  function renderServices(services) {
    const list = document.getElementById('acc-list');
    if (!services || services.length === 0) {
      return;  // empty handler may overwrite below
    }
    list.innerHTML = '';
    services.forEach((s) => {
      const card = document.createElement('div');
      card.className = 'acc-card';
      card.innerHTML =
        '<div>' +
        '  <div class="acc-card-title">' + esc(s.label) + '</div>' +
        '  <div class="acc-card-url">' + esc(s.baseUrl) + '</div>' +
        '</div>' +
        '<div><button data-base="' + esc(s.baseUrl) + '" data-model="' +
          esc(s.modelName || '') + '">Wire to deploy/.env</button></div>';
      card.querySelector('button').addEventListener('click', () => {
        const baseUrl = card.querySelector('button').dataset.base;
        const modelName = card.querySelector('button').dataset.model;
        post({ type: 'wire', baseUrl, modelName: modelName || undefined });
      });
      list.appendChild(card);
    });
  }

  function renderEmpty(reason) {
    const list = document.getElementById('acc-list');
    list.innerHTML = '<div class="acc-empty">' + esc(reason) + '</div>';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
</script>
</body>
</html>`;
}
