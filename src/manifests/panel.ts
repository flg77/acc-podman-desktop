/**
 * Manifest browser panel — three tabs (Roles / Skills / MCPs).
 *
 * Read-only.  The panel surfaces the runtime repo's manifests so
 * operators can see what's loadable, click into a row for details,
 * and "Open in editor" to author changes in their editor of choice.
 *
 * Authoring stays out of the extension by design — the runtime's
 * `acc-cli role lint` + the operator's editor are the canonical
 * authoring surface.
 *
 * Bidirectional message protocol with the webview:
 *   webview → host:
 *     { type: 'refresh' }
 *     { type: 'open',  path: string }
 *   host → webview:
 *     { type: 'data',  roles: RoleSummary[],
 *                     skills: SkillSummary[],
 *                     mcps: McpSummary[] }
 *     { type: 'opened', path: string, command: string }
 *     { type: 'error',  message: string }
 */

import * as extensionApi from '@podman-desktop/api';

import type { AccPaths } from '../core/paths';
import type { Logger } from '../core/logger';
import {
  loadMcps,
  loadRoles,
  loadSkills,
  type McpSummary,
  type RoleSummary,
  type SkillSummary,
} from './loader';
import { openInEditor } from './open-in-editor';


export function registerManifestBrowser(
  paths: AccPaths | undefined,
  log: Logger,
): extensionApi.Disposable[] {
  let webview: extensionApi.WebviewPanel | undefined;

  const showCommand = extensionApi.commands.registerCommand(
    'acc.manifests.show',
    async () => {
      try {
        webview = await openPanel(webview, paths, log);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`manifests.show failed: ${msg}`);
        extensionApi.window.showErrorMessage(
          `ACC manifest browser failed to open: ${msg}`,
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
      await refreshData(existing, paths, log);
      return existing;
    } catch {
      // panel disposed externally; fall through to create.
    }
  }

  const panel = extensionApi.window.createWebviewPanel(
    'acc.manifests',
    'ACC Roles · Skills · MCPs',
  );
  panel.webview.html = renderInitialHtml();

  panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) {
      return;
    }
    const msg = raw as Record<string, unknown>;
    const type = String(msg['type'] ?? '');

    if (type === 'refresh') {
      await refreshData(panel, paths, log);
    } else if (type === 'open') {
      const path = String(msg['path'] ?? '');
      if (!path) {
        return;
      }
      const result = openInEditor(path);
      log.info(`manifests: open ${path} via ${result.command}`);
      try {
        await panel.webview.postMessage({
          type: 'opened',
          path,
          command: result.command,
        });
      } catch {
        // best-effort
      }
    }
  });

  // Initial load.
  await refreshData(panel, paths, log);
  return panel;
}


async function refreshData(
  panel: extensionApi.WebviewPanel,
  paths: AccPaths | undefined,
  log: Logger,
): Promise<void> {
  if (paths === undefined) {
    try {
      await panel.webview.postMessage({
        type: 'error',
        message:
          'ACC repo not configured.  Set "acc.repoPath" in settings to point at the agentic-cell-corpus checkout.',
      });
    } catch {
      // best-effort
    }
    return;
  }
  let roles: RoleSummary[] = [];
  let skills: SkillSummary[] = [];
  let mcps: McpSummary[] = [];
  try {
    [roles, skills, mcps] = await Promise.all([
      loadRoles(paths.repoPath),
      loadSkills(paths.repoPath),
      loadMcps(paths.repoPath),
    ]);
  } catch (err) {
    log.error(
      `manifests: load failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  log.info(
    `manifests: loaded ${roles.length} roles, ${skills.length} skills, ${mcps.length} MCPs`,
  );
  try {
    await panel.webview.postMessage({
      type: 'data',
      roles,
      skills,
      mcps,
    });
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
<title>ACC Roles · Skills · MCPs</title>
<style>
  body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         padding: 1rem; background: #1a1a2e; color: #eee; margin: 0; }
  h1   { font-size: 1.1rem; margin: 0 0 1rem 0; display: flex;
         align-items: center; gap: 0.75rem; }
  .acc-tabs { display: flex; gap: 0.25rem; margin-bottom: 1rem;
              border-bottom: 1px solid #333; }
  .acc-tab { padding: 0.5rem 1rem; cursor: pointer;
             color: #aaa; border-bottom: 2px solid transparent; }
  .acc-tab--active { color: #4a90e2; border-bottom-color: #4a90e2; }
  .acc-tab-counter { font-size: 0.8rem; color: #888; margin-left: 0.4rem; }
  .acc-pane { display: none; }
  .acc-pane--active { display: grid;
                      grid-template-columns: minmax(220px, 1fr) 2fr; gap: 1rem; }
  .acc-list { background: #232342; border-radius: 4px; padding: 0.4rem;
              max-height: 70vh; overflow-y: auto; }
  .acc-row  { padding: 0.4rem 0.6rem; border-radius: 3px; cursor: pointer;
              display: flex; align-items: center; gap: 0.5rem; }
  .acc-row:hover { background: #2c2c54; }
  .acc-row--selected { background: #3a3a6e; }
  .acc-row-name { font-weight: 600; }
  .acc-pill { font-size: 0.75rem; padding: 1px 6px; border-radius: 999px;
              background: #444; color: #ddd; margin-left: auto; }
  .acc-pill--HIGH { background: #b71c1c; color: #fff; }
  .acc-pill--MEDIUM { background: #ef6c00; color: #fff; }
  .acc-pill--LOW { background: #2e7d32; color: #fff; }
  .acc-pill--CRITICAL { background: #4a148c; color: #fff; }
  .acc-detail { background: #232342; border-radius: 4px; padding: 1rem;
                max-height: 70vh; overflow-y: auto; }
  .acc-detail h3 { margin: 0 0 0.5rem 0; font-size: 1rem; }
  .acc-detail dt { color: #aaa; margin-top: 0.5rem; font-size: 0.85rem; }
  .acc-detail dd { margin: 0.1rem 0 0 0; }
  .acc-detail code { background: #15152a; padding: 1px 5px; border-radius: 3px;
                     font-size: 0.85rem; }
  .acc-detail-actions { display: flex; gap: 0.5rem; margin-top: 1rem;
                        flex-wrap: wrap; }
  button { background: #4a90e2; color: white; border: 0; padding: 5px 12px;
           border-radius: 3px; cursor: pointer; font: inherit; font-size: 0.85rem; }
  button:hover { background: #5aa0f2; }
  button.acc-secondary { background: #444; }
  button.acc-secondary:hover { background: #555; }
  .acc-empty { color: #888; font-style: italic; text-align: center;
               padding: 2rem; }
  .acc-error { color: #ef5350; padding: 1rem; background: #3d1f1f;
               border-left: 3px solid #ef5350; border-radius: 3px;
               margin-bottom: 1rem; }
  .acc-toast { position: fixed; bottom: 1rem; right: 1rem;
               background: #1f3d2c; border-left: 3px solid #4caf50;
               padding: 0.5rem 1rem; border-radius: 3px;
               opacity: 0; transition: opacity 0.3s; }
  .acc-toast--visible { opacity: 1; }
</style>
</head>
<body>
<h1>
  <span>ACC Roles · Skills · MCPs</span>
  <button class="acc-secondary" id="acc-refresh">Refresh</button>
</h1>
<div class="acc-error" id="acc-error" style="display:none"></div>

<div class="acc-tabs">
  <div class="acc-tab acc-tab--active" data-tab="roles">
    Roles<span class="acc-tab-counter" data-counter="roles">0</span>
  </div>
  <div class="acc-tab" data-tab="skills">
    Skills<span class="acc-tab-counter" data-counter="skills">0</span>
  </div>
  <div class="acc-tab" data-tab="mcps">
    MCPs<span class="acc-tab-counter" data-counter="mcps">0</span>
  </div>
</div>

<div class="acc-pane acc-pane--active" data-pane="roles">
  <div class="acc-list" data-list="roles"><div class="acc-empty">No roles loaded.</div></div>
  <div class="acc-detail" data-detail="roles"><div class="acc-empty">Select a role to inspect.</div></div>
</div>
<div class="acc-pane" data-pane="skills">
  <div class="acc-list" data-list="skills"><div class="acc-empty">No skills loaded.</div></div>
  <div class="acc-detail" data-detail="skills"><div class="acc-empty">Select a skill to inspect.</div></div>
</div>
<div class="acc-pane" data-pane="mcps">
  <div class="acc-list" data-list="mcps"><div class="acc-empty">No MCPs loaded.</div></div>
  <div class="acc-detail" data-detail="mcps"><div class="acc-empty">Select an MCP to inspect.</div></div>
</div>

<div class="acc-toast" id="acc-toast"></div>

<script>
  const vscode = acquireVsCodeApi ? acquireVsCodeApi() : null;
  const post = (msg) => vscode ? vscode.postMessage(msg) : window.parent?.postMessage(msg, '*');

  // ---- Tab switching ----
  document.querySelectorAll('.acc-tab').forEach((el) => {
    el.addEventListener('click', () => {
      const tab = el.dataset.tab;
      document.querySelectorAll('.acc-tab').forEach((t) =>
        t.classList.toggle('acc-tab--active', t.dataset.tab === tab));
      document.querySelectorAll('.acc-pane').forEach((p) =>
        p.classList.toggle('acc-pane--active', p.dataset.pane === tab));
    });
  });

  document.getElementById('acc-refresh').addEventListener('click', () => {
    post({ type: 'refresh' });
  });

  // ---- Data fan-in ----
  let data = { roles: [], skills: [], mcps: [] };

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'data') {
      hideError();
      data = { roles: msg.roles || [], skills: msg.skills || [], mcps: msg.mcps || [] };
      updateCounters();
      renderList('roles', renderRoleRow);
      renderList('skills', renderSkillRow);
      renderList('mcps', renderMcpRow);
    } else if (msg.type === 'error') {
      showError(msg.message || 'Unknown error');
    } else if (msg.type === 'opened') {
      showToast('Opened ' + msg.path.split(/[\\\\/]/).pop() + ' (' + msg.command + ')');
    }
  });

  function updateCounters() {
    document.querySelector('[data-counter="roles"]').textContent = data.roles.length;
    document.querySelector('[data-counter="skills"]').textContent = data.skills.length;
    document.querySelector('[data-counter="mcps"]').textContent = data.mcps.length;
  }

  function renderList(kind, rowFn) {
    const list = document.querySelector('[data-list="' + kind + '"]');
    if (!data[kind] || data[kind].length === 0) {
      list.innerHTML = '<div class="acc-empty">No ' + kind + ' loaded.</div>';
      return;
    }
    list.innerHTML = '';
    data[kind].forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'acc-row';
      row.innerHTML = rowFn(item);
      row.addEventListener('click', () => selectRow(kind, idx, row));
      list.appendChild(row);
    });
  }

  function selectRow(kind, idx, rowEl) {
    document.querySelectorAll('[data-list="' + kind + '"] .acc-row').forEach((r) =>
      r.classList.remove('acc-row--selected'));
    rowEl.classList.add('acc-row--selected');
    const item = data[kind][idx];
    const detail = document.querySelector('[data-detail="' + kind + '"]');
    detail.innerHTML = renderDetail(kind, item);
    detail.querySelectorAll('button[data-open-path]').forEach((btn) => {
      btn.addEventListener('click', () => {
        post({ type: 'open', path: btn.dataset.openPath });
      });
    });
  }

  // ---- Row + detail templates ----
  function renderRoleRow(role) {
    return '<span class="acc-row-name">' + esc(role.name) + '</span>'
      + '<span class="acc-pill acc-pill--' + esc(role.max_skill_risk_level) + '">'
      + esc(role.max_skill_risk_level) + '</span>';
  }
  function renderSkillRow(s) {
    return '<span class="acc-row-name">' + esc(s.name) + '</span>'
      + '<span class="acc-pill acc-pill--' + esc(s.risk_level) + '">'
      + esc(s.risk_level) + '</span>';
  }
  function renderMcpRow(m) {
    return '<span class="acc-row-name">' + esc(m.name) + '</span>'
      + '<span class="acc-pill acc-pill--' + esc(m.risk_level) + '">'
      + esc(m.risk_level) + '</span>';
  }

  function renderDetail(kind, item) {
    if (kind === 'roles') return renderRoleDetail(item);
    if (kind === 'skills') return renderSkillDetail(item);
    return renderMcpDetail(item);
  }

  function renderRoleDetail(r) {
    return '<h3>' + esc(r.name) + '</h3>'
      + '<dl>'
      + dt('Purpose') + dd(esc(r.purpose) || '<em>(none)</em>')
      + dt('Persona') + dd('<code>' + esc(r.persona) + '</code>')
      + dt('Domain') + dd(esc(r.domain_id) + ' · receptors: ' + esc(r.domain_receptors.join(', ') || '(none)'))
      + dt('Max parallel tasks') + dd(String(r.max_parallel_tasks))
      + dt('Estimator') + dd('<code>' + esc(r.estimator_strategy) + '</code>')
      + dt('Default skills') + dd(r.default_skills.map((x) => '<code>' + esc(x) + '</code>').join(' ') || '(none)')
      + dt('Allowed skills') + dd(r.allowed_skills.map((x) => '<code>' + esc(x) + '</code>').join(' ') || '(none)')
      + dt('Max skill risk') + dd('<code>' + esc(r.max_skill_risk_level) + '</code>')
      + dt('Default MCPs') + dd(r.default_mcps.map((x) => '<code>' + esc(x) + '</code>').join(' ') || '(none)')
      + dt('Allowed MCPs') + dd(r.allowed_mcps.map((x) => '<code>' + esc(x) + '</code>').join(' ') || '(none)')
      + dt('Max MCP risk') + dd('<code>' + esc(r.max_mcp_risk_level) + '</code>')
      + '</dl>'
      + '<div class="acc-detail-actions">'
      + (r.files.role_md ? openBtn('Open role.md', r.files.role_md) : '')
      + openBtn('Open role.yaml', r.files.role_yaml)
      + (r.files.system_prompt_md ? openBtn('Open system_prompt.md', r.files.system_prompt_md) : '')
      + (r.files.eval_rubric_yaml ? openBtn('Open eval_rubric.yaml', r.files.eval_rubric_yaml) : '')
      + '</div>';
  }
  function renderSkillDetail(s) {
    return '<h3>' + esc(s.name) + '</h3>'
      + '<dl>'
      + dt('Purpose') + dd(esc(s.purpose) || '<em>(none)</em>')
      + dt('Version') + dd('<code>' + esc(s.version) + '</code>')
      + dt('Risk') + dd('<code>' + esc(s.risk_level) + '</code>')
      + dt('Domain') + dd('<code>' + esc(s.domain_id) + '</code>')
      + dt('Tags') + dd(s.tags.map((x) => '<code>' + esc(x) + '</code>').join(' ') || '(none)')
      + '</dl>'
      + '<div class="acc-detail-actions">'
      + openBtn('Open skill.yaml', s.files.skill_yaml)
      + (s.files.adapter_py ? openBtn('Open adapter.py', s.files.adapter_py) : '')
      + '</div>';
  }
  function renderMcpDetail(m) {
    return '<h3>' + esc(m.name) + '</h3>'
      + '<dl>'
      + dt('Purpose') + dd(esc(m.purpose) || '<em>(none)</em>')
      + dt('Transport') + dd('<code>' + esc(m.transport) + '</code>')
      + dt('Risk') + dd('<code>' + esc(m.risk_level) + '</code>')
      + dt('Domain') + dd('<code>' + esc(m.domain_id) + '</code>')
      + dt('Allowed tools') + dd(m.allowed_tools.map((x) => '<code>' + esc(x) + '</code>').join(' ') || '(none)')
      + '</dl>'
      + '<div class="acc-detail-actions">'
      + openBtn('Open mcp.yaml', m.files.mcp_yaml)
      + '</div>';
  }

  function dt(label) { return '<dt>' + esc(label) + '</dt>'; }
  function dd(html)  { return '<dd>' + html + '</dd>'; }
  function openBtn(label, path) {
    return '<button data-open-path="' + esc(path) + '">' + esc(label) + '</button>';
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
