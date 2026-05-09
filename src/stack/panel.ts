/**
 * Stack provisioning panel — first-class UI for the four
 * lifecycle commands the existing `acc.stack.*` set already
 * registers, plus inline `deploy/.env` editing + preset
 * dropdown + profile checkboxes + live container status.
 *
 * Bidirectional message protocol with the webview:
 *   webview → host:
 *     { type: 'refresh' }
 *     { type: 'up' | 'down' | 'rebuild' | 'status' }
 *     { type: 'apply-preset', preset: string }
 *     { type: 'save-env',     contents: string }
 *     { type: 'save-profiles', state: ProfileState }
 *     { type: 'kill' }
 *   host → webview:
 *     { type: 'state', running: boolean }
 *     { type: 'log',   kind: 'stdout'|'stderr', text: string }
 *     { type: 'data',  presets: PresetSummary[],
 *                      env: { contents: string, path: string },
 *                      profiles: ProfileState,
 *                      containers: ContainerStatus[] }
 *     { type: 'toast', message: string, kind: 'ok'|'error' }
 */

import * as extensionApi from '@podman-desktop/api';

import type { AccPaths } from '../core/paths';
import type { Logger } from '../core/logger';
import { runScript, type RunnerHandle } from '../examples/runner';
import {
  applyPreset,
  listPresets,
  patchProfileState,
  PROFILE_KEYS,
  readDeployEnv,
  readProfileState,
  writeDeployEnv,
  type ProfileKey,
  type ProfileState,
} from './env-file';
import { listAccContainers } from './status';


export function registerStackPanel(
  paths: AccPaths | undefined,
  log: Logger,
): extensionApi.Disposable[] {
  let webview: extensionApi.WebviewPanel | undefined;
  let runner: RunnerHandle | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  const showCommand = extensionApi.commands.registerCommand(
    'acc.stack.show',
    async () => {
      try {
        webview = await openPanel({
          existing: webview,
          paths,
          log,
          getRunner: () => runner,
          setRunner: (r) => {
            runner = r;
          },
          startRefresh: (cb) => {
            if (refreshTimer === undefined) {
              refreshTimer = setInterval(cb, 5_000);
            }
          },
          stopRefresh: () => {
            if (refreshTimer !== undefined) {
              clearInterval(refreshTimer);
              refreshTimer = undefined;
            }
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`stack.show failed: ${msg}`);
        extensionApi.window.showErrorMessage(
          `ACC stack panel failed to open: ${msg}`,
        );
      }
    },
  );

  return [
    showCommand,
    {
      dispose: () => {
        if (runner !== undefined) {
          runner.kill();
        }
        if (refreshTimer !== undefined) {
          clearInterval(refreshTimer);
        }
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


interface OpenArgs {
  existing: extensionApi.WebviewPanel | undefined;
  paths: AccPaths | undefined;
  log: Logger;
  getRunner: () => RunnerHandle | undefined;
  setRunner: (r: RunnerHandle | undefined) => void;
  startRefresh: (cb: () => void) => void;
  stopRefresh: () => void;
}


async function openPanel(args: OpenArgs): Promise<extensionApi.WebviewPanel> {
  if (args.existing !== undefined) {
    try {
      args.existing.reveal();
      await refreshData(args.existing, args.paths);
      return args.existing;
    } catch {
      // disposed externally
    }
  }

  const panel = extensionApi.window.createWebviewPanel(
    'acc.stack',
    'ACC Stack',
  );
  panel.webview.html = renderInitialHtml();

  panel.onDidDispose(() => {
    args.stopRefresh();
    const r = args.getRunner();
    if (r !== undefined) {
      r.kill();
    }
    args.setRunner(undefined);
  });

  panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) {
      return;
    }
    const msg = raw as Record<string, unknown>;
    const type = String(msg['type'] ?? '');

    try {
      if (type === 'refresh') {
        await refreshData(panel, args.paths);
        return;
      }
      if (type === 'up' || type === 'down' || type === 'rebuild' || type === 'status') {
        if (args.paths === undefined) {
          await postToast(panel, 'ACC repo not configured', 'error');
          return;
        }
        if (args.getRunner()?.isRunning()) {
          await postToast(panel, 'A stack action is already running', 'error');
          return;
        }
        await runDeployCommand(panel, args, type);
        return;
      }
      if (type === 'apply-preset') {
        const preset = String(msg['preset'] ?? '');
        await handleApplyPreset(panel, args.paths, preset);
        return;
      }
      if (type === 'save-env') {
        const contents = String(msg['contents'] ?? '');
        await handleSaveEnv(panel, args.paths, contents);
        return;
      }
      if (type === 'save-profiles') {
        await handleSaveProfiles(
          panel,
          args.paths,
          (msg['state'] as Record<string, unknown>) ?? {},
        );
        return;
      }
      if (type === 'kill') {
        const r = args.getRunner();
        if (r !== undefined) {
          r.kill();
        }
        return;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      args.log.error(`stack panel: ${type}: ${errMsg}`);
      await postToast(panel, errMsg, 'error');
    }
  });

  // Initial load + periodic container-status refresh.
  await refreshData(panel, args.paths);
  args.startRefresh(() => {
    void refreshData(panel, args.paths);
  });
  return panel;
}


// ---------------------------------------------------------------------------
// Data fetch — called on open + every 5 s + after each action.
// ---------------------------------------------------------------------------


async function refreshData(
  panel: extensionApi.WebviewPanel,
  paths: AccPaths | undefined,
): Promise<void> {
  if (paths === undefined) {
    await postToast(
      panel,
      'ACC repo not configured.  Set "acc.repoPath" in settings.',
      'error',
    );
    return;
  }
  const [presets, env, containers] = await Promise.all([
    listPresets(paths.repoPath),
    readDeployEnv(paths.repoPath),
    listAccContainers(),
  ]);
  const profiles = readProfileState(env.contents);
  try {
    await panel.webview.postMessage({
      type: 'data',
      presets,
      env: { contents: env.contents ?? '', path: env.path },
      profiles,
      containers,
    });
  } catch {
    // best-effort
  }
}


// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------


async function runDeployCommand(
  panel: extensionApi.WebviewPanel,
  args: OpenArgs,
  subcommand: 'up' | 'down' | 'rebuild' | 'status',
): Promise<void> {
  const paths = args.paths;
  if (paths === undefined) {
    return;
  }
  await postState(panel, true);
  await postLog(panel, 'stdout', `▶ ${paths.deployScript} ${subcommand}\n`);
  const handle = runScript({
    command: paths.deployScript,
    args: [subcommand],
    cwd: paths.repoPath,
    onChunk: (kind, text) => {
      void postLog(panel, kind, text);
    },
  });
  args.setRunner(handle);
  const code = await handle.promise;
  args.setRunner(undefined);
  await postLog(panel, 'stdout', `\n[exit ${code}]\n`);
  await postState(panel, false);
  if (code === 0) {
    await postToast(panel, `acc-deploy.sh ${subcommand}: OK`, 'ok');
  } else {
    await postToast(
      panel,
      `acc-deploy.sh ${subcommand} failed (exit ${code})`,
      'error',
    );
  }
  // Refresh container list + env state in case `up` / `rebuild`
  // changed them.
  await refreshData(panel, paths);
}


async function handleApplyPreset(
  panel: extensionApi.WebviewPanel,
  paths: AccPaths | undefined,
  presetName: string,
): Promise<void> {
  if (paths === undefined || !presetName) {
    return;
  }
  const result = await applyPreset(paths.repoPath, presetName);
  if (!result.ok) {
    await postToast(
      panel,
      `Apply preset failed: ${result.reason ?? 'unknown error'}`,
      'error',
    );
    return;
  }
  const backupNote = result.backupPath
    ? ` (existing deploy/.env saved to .bak)`
    : '';
  await postToast(
    panel,
    `Preset applied → deploy/.env${backupNote}.  Edit API keys, then bring stack up.`,
    'ok',
  );
  await refreshData(panel, paths);
}


async function handleSaveEnv(
  panel: extensionApi.WebviewPanel,
  paths: AccPaths | undefined,
  contents: string,
): Promise<void> {
  if (paths === undefined) {
    return;
  }
  const path = await writeDeployEnv(paths.repoPath, contents);
  await postToast(panel, `Saved ${path}`, 'ok');
  await refreshData(panel, paths);
}


async function handleSaveProfiles(
  panel: extensionApi.WebviewPanel,
  paths: AccPaths | undefined,
  raw: Record<string, unknown>,
): Promise<void> {
  if (paths === undefined) {
    return;
  }
  const state: ProfileState = {
    TUI: false, CODING_SPLIT: false, AUTORESEARCHER: false,
    MCP_ECHO: false, DETACH: false,
  };
  for (const key of PROFILE_KEYS) {
    state[key as ProfileKey] = Boolean(raw[key]);
  }
  const env = await readDeployEnv(paths.repoPath);
  const patched = patchProfileState(env.contents, state);
  await writeDeployEnv(paths.repoPath, patched);
  await postToast(
    panel,
    `Profiles saved.  Re-run "Up" to apply (existing containers keep their old env).`,
    'ok',
  );
  await refreshData(panel, paths);
}


// ---------------------------------------------------------------------------
// Webview message senders
// ---------------------------------------------------------------------------


async function postLog(
  panel: extensionApi.WebviewPanel,
  kind: 'stdout' | 'stderr',
  text: string,
): Promise<void> {
  try {
    await panel.webview.postMessage({ type: 'log', kind, text });
  } catch {
    // best-effort
  }
}


async function postState(
  panel: extensionApi.WebviewPanel,
  running: boolean,
): Promise<void> {
  try {
    await panel.webview.postMessage({ type: 'state', running });
  } catch {
    // best-effort
  }
}


async function postToast(
  panel: extensionApi.WebviewPanel,
  message: string,
  kind: 'ok' | 'error',
): Promise<void> {
  try {
    await panel.webview.postMessage({ type: 'toast', message, kind });
  } catch {
    // best-effort
  }
}


// ---------------------------------------------------------------------------
// Initial HTML
// ---------------------------------------------------------------------------


function renderInitialHtml(): string {
  const profileChecks = PROFILE_KEYS.map(
    (k) =>
      `<label class="acc-check"><input type="checkbox" data-profile="${k}" /> <code>${k}</code></label>`,
  ).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ACC Stack</title>
<style>
  body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         padding: 1rem; background: #1a1a2e; color: #eee; margin: 0; }
  h1   { font-size: 1.1rem; margin: 0 0 1rem 0; display: flex;
         align-items: center; gap: 0.75rem; }
  h2   { font-size: 0.95rem; margin: 1.25rem 0 0.5rem 0; color: #ccc; }
  .acc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .acc-card { background: #232342; border-radius: 4px; padding: 0.75rem 1rem; }
  .acc-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;
                 margin-bottom: 0.5rem; }
  button { background: #4a90e2; color: white; border: 0; padding: 6px 14px;
           border-radius: 3px; cursor: pointer; font: inherit; }
  button:hover { background: #5aa0f2; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.acc-secondary { background: #444; }
  button.acc-secondary:hover { background: #555; }
  button.acc-danger { background: #ef5350; }
  .acc-status-pill { font-size: 0.85rem; min-width: 9ch; color: #888;
                     padding-left: 0.5rem; }
  .acc-status-pill--running { color: #ffd54f; }
  .acc-presets { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  select, textarea { background: #15152a; color: #eee; border: 1px solid #444;
                     border-radius: 3px; padding: 4px 8px; font: inherit; }
  textarea { width: 100%; min-height: 18rem; font-family: ui-monospace, monospace;
             font-size: 12px; box-sizing: border-box; }
  .acc-check { display: inline-flex; gap: 0.4rem; align-items: center;
               margin-right: 1rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  table th, table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #2a2a4a; }
  table th { color: #888; font-weight: 600; }
  .acc-state { display: inline-block; min-width: 8ch; }
  .acc-state--running { color: #4caf50; }
  .acc-state--exited { color: #888; }
  .acc-state--paused { color: #ffd54f; }
  .acc-empty { color: #888; font-style: italic; padding: 1rem; text-align: center; }
  .acc-toast { position: fixed; bottom: 1rem; right: 1rem; padding: 0.5rem 1rem;
               border-radius: 3px; opacity: 0; transition: opacity 0.3s; max-width: 32rem; }
  .acc-toast--visible { opacity: 1; }
  .acc-toast--ok    { background: #1f3d2c; border-left: 3px solid #4caf50; color: #c8f7c5; }
  .acc-toast--error { background: #3d1f1f; border-left: 3px solid #ef5350; color: #ffab91; }
  .acc-log { background: #0e0e1c; padding: 0.5rem 0.75rem;
             font: 11px/1.4 ui-monospace, SFMono-Regular, monospace;
             white-space: pre-wrap; word-break: break-word;
             max-height: 16rem; overflow-y: auto; border-radius: 3px;
             margin-top: 0.5rem; }
  .acc-log .acc-log-stderr { color: #ffab91; }
  .acc-deploy-path { font-size: 0.85rem; color: #888; }
</style>
</head>
<body>
<h1>
  <span>ACC Stack</span>
  <button class="acc-secondary" id="acc-refresh">Refresh</button>
  <span class="acc-status-pill" id="acc-status-pill"></span>
</h1>

<section class="acc-card">
  <h2>Lifecycle</h2>
  <div class="acc-actions">
    <button data-cmd="up">Up</button>
    <button data-cmd="down" class="acc-secondary">Down</button>
    <button data-cmd="rebuild" class="acc-secondary">Rebuild</button>
    <button data-cmd="status" class="acc-secondary">Status</button>
    <button data-cmd="kill" class="acc-danger" disabled>Stop running command</button>
  </div>
  <pre class="acc-log" id="acc-log"></pre>
</section>

<div class="acc-grid">
  <section class="acc-card">
    <h2>Containers</h2>
    <table id="acc-containers">
      <thead>
        <tr><th>Name</th><th>State</th><th>Status</th></tr>
      </thead>
      <tbody><tr><td colspan="3" class="acc-empty">Refreshing…</td></tr></tbody>
    </table>
  </section>
  <section class="acc-card">
    <h2>Profiles (deploy/.env)</h2>
    <div id="acc-profiles">${profileChecks}</div>
    <div class="acc-actions" style="margin-top: 0.5rem">
      <button data-cmd="save-profiles">Save profiles</button>
    </div>
  </section>
</div>

<section class="acc-card">
  <h2>deploy/.env <span class="acc-deploy-path" id="acc-env-path"></span></h2>
  <div class="acc-presets">
    <label>Apply preset:
      <select id="acc-preset-select"><option value="">— pick a preset —</option></select>
    </label>
    <button data-cmd="apply-preset" class="acc-secondary">Apply</button>
  </div>
  <textarea id="acc-env-textarea" spellcheck="false" placeholder="(deploy/.env not yet authored — pick a preset above or type below)"></textarea>
  <div class="acc-actions">
    <button data-cmd="save-env">Save deploy/.env</button>
  </div>
</section>

<div class="acc-toast" id="acc-toast"></div>

<script>
  const vscode = acquireVsCodeApi ? acquireVsCodeApi() : null;
  const post = (msg) => vscode ? vscode.postMessage(msg) : window.parent?.postMessage(msg, '*');

  document.getElementById('acc-refresh').addEventListener('click', () =>
    post({ type: 'refresh' }));

  document.querySelectorAll('button[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd;
      if (cmd === 'apply-preset') {
        const v = document.getElementById('acc-preset-select').value;
        if (!v) { showToast('Pick a preset first', 'error'); return; }
        post({ type: 'apply-preset', preset: v });
      } else if (cmd === 'save-env') {
        const contents = document.getElementById('acc-env-textarea').value;
        post({ type: 'save-env', contents });
      } else if (cmd === 'save-profiles') {
        const state = {};
        document.querySelectorAll('input[data-profile]').forEach((c) => {
          state[c.dataset.profile] = c.checked;
        });
        post({ type: 'save-profiles', state });
      } else {
        post({ type: cmd });
      }
    });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'data') applyData(msg);
    else if (msg.type === 'state') applyState(msg.running);
    else if (msg.type === 'log') appendLog(msg.kind, msg.text);
    else if (msg.type === 'toast') showToast(msg.message, msg.kind);
  });

  function applyData(msg) {
    // Presets
    const sel = document.getElementById('acc-preset-select');
    sel.innerHTML = '<option value="">— pick a preset —</option>';
    msg.presets.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.name;
      o.textContent = p.name + (p.blurb ? ' — ' + p.blurb : '');
      sel.appendChild(o);
    });
    // deploy/.env
    document.getElementById('acc-env-textarea').value = msg.env.contents || '';
    document.getElementById('acc-env-path').textContent = msg.env.path;
    // Profile checkboxes
    document.querySelectorAll('input[data-profile]').forEach((c) => {
      c.checked = !!msg.profiles[c.dataset.profile];
    });
    // Container table
    const tbody = document.querySelector('#acc-containers tbody');
    if (!msg.containers || msg.containers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="acc-empty">No ACC containers detected.</td></tr>';
    } else {
      tbody.innerHTML = '';
      msg.containers.forEach((c) => {
        const tr = document.createElement('tr');
        const stateClass = 'acc-state acc-state--' + (c.state || 'exited').toLowerCase();
        tr.innerHTML =
          '<td><code>' + esc(c.name) + '</code></td>' +
          '<td><span class="' + stateClass + '">' + esc(c.state) + '</span></td>' +
          '<td>' + esc(c.status) + '</td>';
        tbody.appendChild(tr);
      });
    }
  }

  function applyState(running) {
    const pill = document.getElementById('acc-status-pill');
    pill.textContent = running ? '● running…' : '';
    pill.className = 'acc-status-pill' + (running ? ' acc-status-pill--running' : '');
    document.querySelectorAll('button[data-cmd]').forEach((b) => {
      const cmd = b.dataset.cmd;
      if (cmd === 'kill') b.disabled = !running;
      else b.disabled = running;
    });
  }

  function appendLog(kind, text) {
    const el = document.getElementById('acc-log');
    const span = document.createElement('span');
    if (kind === 'stderr') span.className = 'acc-log-stderr';
    span.textContent = text;
    el.appendChild(span);
    el.scrollTop = el.scrollHeight;
  }

  function showToast(text, kind) {
    const t = document.getElementById('acc-toast');
    t.textContent = text;
    t.className = 'acc-toast acc-toast--visible acc-toast--' + (kind || 'ok');
    setTimeout(() => t.classList.remove('acc-toast--visible'), 3500);
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
