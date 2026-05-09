/**
 * Prompt-pane bridge — ad-hoc dispatch surface mirroring the TUI's
 * screen 7.  Operator types a prompt + selects target_role
 * (optional target_agent_id), the panel publishes TASK_ASSIGN and
 * renders the streaming TASK_PROGRESS + final TASK_COMPLETE in a
 * conversation-style transcript.
 *
 * Bidirectional message protocol:
 *   webview → host:
 *     { type: 'send', targetRole, targetAgentId?, taskType?, prompt }
 *     { type: 'cancel' }       // best-effort — only stops the local
 *                              // wait, the runtime doesn't yet honour
 *                              // operator-side TASK_CANCEL.
 *   host → webview:
 *     { type: 'meta',     cid, natsUrl, connected, message? }
 *     { type: 'sent',     taskId, role, agentId?, prompt }
 *     { type: 'progress', taskId, stepLabel, currentStep, totalSteps }
 *     { type: 'complete', taskId, agentId, output, blocked, blockReason,
 *                          latencyMs }
 *     { type: 'error',    taskId?, message }
 */

import * as extensionApi from '@podman-desktop/api';

import type { AccPaths } from '../core/paths';
import type { Logger } from '../core/logger';
import { panicRegistry } from '../core/panic';
import { PromptChannel } from './channel';


interface PanelState {
  panel: extensionApi.WebviewPanel;
  channel: PromptChannel | undefined;
  cid: string;
  natsUrl: string;
  panicHandle: { unregister: () => void } | undefined;
}


export function registerPromptPanel(
  _paths: AccPaths | undefined,
  log: Logger,
): extensionApi.Disposable[] {
  let state: PanelState | undefined;

  const showCommand = extensionApi.commands.registerCommand(
    'acc.prompt.show',
    async () => {
      try {
        state = await openPanel(state, log);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        log.error(`prompt.show failed: ${m}`);
        extensionApi.window.showErrorMessage(
          `ACC prompt panel failed to open: ${m}`,
        );
      }
    },
  );

  return [
    showCommand,
    {
      dispose: () => {
        if (state !== undefined) {
          void teardown(state);
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
      return existing;
    } catch {
      // disposed externally — fall through.
    }
  }

  const config = extensionApi.configuration.getConfiguration('acc');
  const cid = config.get<string>('collectiveId') ?? 'sol-01';
  const natsUrl = config.get<string>('natsUrl') ?? 'nats://localhost:4222';

  const panel = extensionApi.window.createWebviewPanel(
    'acc.prompt',
    'ACC Prompt',
  );
  panel.webview.html = renderHtml();

  const state: PanelState = {
    panel,
    channel: undefined,
    cid,
    natsUrl,
    panicHandle: undefined,
  };
  state.panicHandle = panicRegistry.register({
    label: `prompt(${cid})`,
    dispose: () => teardown(state),
  });

  panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) {
      return;
    }
    const msg = raw as Record<string, unknown>;
    const type = String(msg['type'] ?? '');
    if (type === 'send') {
      await handleSend(state, msg, log);
    }
  });

  panel.onDidDispose(() => {
    void teardown(state);
  });

  // Connect lazily to NATS.
  try {
    state.channel = new PromptChannel({
      natsUrl,
      collectiveId: cid,
      defaultTimeoutMs: 120_000,
    });
    await state.channel.connect();
    log.info(`prompt: connected to ${natsUrl}`);
    await postSafe(panel, {
      type: 'meta',
      cid,
      natsUrl,
      connected: true,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log.warn(`prompt: NATS connect failed: ${m}`);
    state.channel = undefined;
    await postSafe(panel, {
      type: 'meta',
      cid,
      natsUrl,
      connected: false,
      message: `NATS connect failed: ${m}`,
    });
  }

  return state;
}


async function handleSend(
  state: PanelState,
  msg: Record<string, unknown>,
  log: Logger,
): Promise<void> {
  if (state.channel === undefined) {
    await postSafe(state.panel, {
      type: 'error',
      message: 'NATS not connected.  Re-open the panel after fixing acc.natsUrl.',
    });
    return;
  }
  const targetRole = String(msg['targetRole'] ?? '').trim();
  const prompt = String(msg['prompt'] ?? '').trim();
  if (!targetRole || !prompt) {
    await postSafe(state.panel, {
      type: 'error',
      message: 'target_role and prompt are both required.',
    });
    return;
  }
  const targetAgentId = msg['targetAgentId']
    ? String(msg['targetAgentId']).trim()
    : undefined;
  const taskType = msg['taskType'] ? String(msg['taskType']).trim() : undefined;

  try {
    const { taskId, completion } = await state.channel.send({
      targetRole,
      targetAgentId,
      taskType,
      taskDescription: prompt,
      onProgress: (p) => {
        void postSafe(state.panel, {
          type: 'progress',
          taskId,
          stepLabel: p.step_label,
          currentStep: p.current_step,
          totalSteps: p.total_steps,
        });
      },
    });
    log.info(
      `prompt: sent task=${taskId} role=${targetRole}` +
        (targetAgentId ? ` agent=${targetAgentId}` : ''),
    );
    await postSafe(state.panel, {
      type: 'sent',
      taskId,
      role: targetRole,
      agentId: targetAgentId,
      prompt,
    });
    try {
      const c = await completion;
      await postSafe(state.panel, {
        type: 'complete',
        taskId,
        agentId: c.agent_id,
        output: c.output,
        blocked: c.blocked,
        blockReason: c.block_reason,
        latencyMs: c.latency_ms,
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      log.warn(`prompt: task=${taskId} failed: ${m}`);
      await postSafe(state.panel, {
        type: 'error',
        taskId,
        message: m,
      });
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    log.error(`prompt: send failed: ${m}`);
    await postSafe(state.panel, {
      type: 'error',
      message: `send failed: ${m}`,
    });
  }
}


async function teardown(state: PanelState): Promise<void> {
  if (state.panicHandle !== undefined) {
    state.panicHandle.unregister();
    state.panicHandle = undefined;
  }
  if (state.channel !== undefined) {
    try {
      await state.channel.close();
    } catch {
      // best-effort
    }
    state.channel = undefined;
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


function renderHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ACC Prompt</title>
<style>
  body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         padding: 1rem; background: #1a1a2e; color: #eee; margin: 0; }
  h1 { font-size: 1.1rem; margin: 0 0 0.5rem 0; }
  .meta { font-size: 0.8rem; color: #888; margin-bottom: 0.6rem; }
  .meta--bad { color: #ef5350; }
  .layout { display: grid;
            grid-template-columns: minmax(20rem, 28rem) 1fr; gap: 1rem;
            min-height: 80vh; }
  @media (max-width: 800px) { .layout { grid-template-columns: 1fr; } }
  .form { background: #232342; border-radius: 4px; padding: 0.85rem 1rem;
          align-self: start; }
  .form label { display: block; color: #aaa; font-size: 0.78rem;
                margin: 0.6rem 0 0.2rem 0;
                text-transform: uppercase; letter-spacing: 0.05em; }
  .form label:first-child { margin-top: 0; }
  .form input, .form textarea {
    width: 100%; box-sizing: border-box; background: #15152a; color: #eee;
    border: 1px solid #444; padding: 6px 8px; font: inherit; font-size: 0.85rem;
  }
  .form textarea { min-height: 8rem; font-family: ui-monospace, "Consolas", monospace; }
  .form .row { display: flex; gap: 0.5rem; align-items: center;
                margin-top: 0.75rem; }
  button { background: #4a90e2; color: white; border: 0; padding: 6px 14px;
           border-radius: 3px; cursor: pointer; font: inherit; font-size: 0.85rem; }
  button:hover { background: #5aa0f2; }
  button:disabled { background: #333; cursor: not-allowed; color: #888; }
  .history { background: #232342; border-radius: 4px; padding: 0.85rem 1rem;
             overflow-y: auto; max-height: 80vh; }
  .turn { background: #1a1a2e; border-radius: 4px; padding: 0.6rem 0.85rem;
          margin-bottom: 0.75rem; border-left: 3px solid #4a90e2; }
  .turn--complete { border-left-color: #4caf50; }
  .turn--error { border-left-color: #ef5350; }
  .turn--blocked { border-left-color: #ef6c00; }
  .turn-meta { font-size: 0.78rem; color: #888; display: flex; gap: 0.5rem;
                flex-wrap: wrap; margin-bottom: 0.4rem; }
  .turn-prompt { font-family: ui-monospace, "Consolas", monospace;
                  white-space: pre-wrap; font-size: 0.85rem;
                  color: #ce93d8; margin-bottom: 0.5rem; }
  .turn-output { font-family: ui-monospace, "Consolas", monospace;
                  white-space: pre-wrap; font-size: 0.85rem; }
  .turn-progress { font-size: 0.8rem; color: #aaa; font-style: italic; }
  .turn-progress::before { content: "▸ "; color: #4a90e2; font-style: normal; }
  code { background: #15152a; padding: 1px 4px; border-radius: 3px;
         font-size: 0.85em; }
  .empty { color: #888; font-style: italic; padding: 1rem; }
  .acc-banner { background: #1c2530; padding: 0.5rem 0.85rem; border-radius: 4px;
                 border-left: 3px solid #4a90e2; font-size: 0.8rem;
                 color: #ccc; margin-bottom: 0.75rem; }
</style>
</head>
<body>
<h1>ACC · Prompt</h1>
<div class="meta" id="acc-meta">connecting…</div>
<div class="acc-banner">
  Ad-hoc dispatch — publishes <code>TASK_ASSIGN</code> on
  <code>acc.{cid}.task</code> with <code>from_agent="pd-extension"</code>.
  Wire-shape parity with the runtime TUI's screen 7.
</div>

<div class="layout">
  <div class="form">
    <label for="acc-role">Target role <span style="color:#ef5350">*</span></label>
    <input id="acc-role" placeholder="coding_agent / arbiter / research_planner">

    <label for="acc-agent">Target agent_id (optional — single agent override)</label>
    <input id="acc-agent" placeholder="acc-agent-coding-1">

    <label for="acc-task-type">Task type (optional — defaults to ADHOC)</label>
    <input id="acc-task-type" placeholder="ADHOC">

    <label for="acc-prompt">Prompt <span style="color:#ef5350">*</span></label>
    <textarea id="acc-prompt"
      placeholder="Generate a small unit test for FizzBuzz."></textarea>

    <div class="row">
      <button id="acc-send">Send</button>
      <span style="color:#888; font-size:0.78rem">⌘/Ctrl+Enter</span>
    </div>
  </div>

  <div class="history" id="acc-history">
    <div class="empty">No turns yet — send a prompt to begin.</div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi ? acquireVsCodeApi() : null;
  const post = (msg) => vscode ? vscode.postMessage(msg) : window.parent?.postMessage(msg, '*');

  // Per-turn DOM nodes keyed by task_id.
  const turns = new Map();

  document.getElementById('acc-send').addEventListener('click', send);
  document.getElementById('acc-prompt').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  });

  function send() {
    const role = document.getElementById('acc-role').value.trim();
    const agent = document.getElementById('acc-agent').value.trim();
    const taskType = document.getElementById('acc-task-type').value.trim();
    const prompt = document.getElementById('acc-prompt').value.trim();
    if (!role || !prompt) {
      flashError('target_role and prompt are required.');
      return;
    }
    post({
      type: 'send',
      targetRole: role,
      targetAgentId: agent || undefined,
      taskType: taskType || undefined,
      prompt,
    });
  }

  function flashError(message) {
    const history = document.getElementById('acc-history');
    const node = document.createElement('div');
    node.className = 'turn turn--error';
    node.innerHTML = '<div class="turn-output">' + esc(message) + '</div>';
    history.prepend(node);
  }

  function ensureTurn(taskId) {
    if (turns.has(taskId)) return turns.get(taskId);
    const history = document.getElementById('acc-history');
    const empty = history.querySelector('.empty');
    if (empty) empty.remove();
    const turn = document.createElement('div');
    turn.className = 'turn';
    history.prepend(turn);
    turns.set(taskId, turn);
    return turn;
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'meta') {
      const meta = document.getElementById('acc-meta');
      if (msg.connected) {
        meta.textContent = 'Collective: ' + msg.cid + ' · NATS: ' + msg.natsUrl + ' · live';
        meta.className = 'meta';
      } else {
        meta.textContent = 'Collective: ' + msg.cid + ' · NATS: ' + msg.natsUrl
          + ' · ' + (msg.message || 'not connected');
        meta.className = 'meta meta--bad';
      }
    } else if (msg.type === 'sent') {
      const t = ensureTurn(msg.taskId);
      t.dataset.role = msg.role;
      const agentSpan = msg.agentId ? ' → <code>' + esc(msg.agentId) + '</code>' : '';
      t.innerHTML =
        '<div class="turn-meta">' +
        '  <code>' + esc(msg.taskId.slice(0, 8)) + '</code>' +
        '  · role <code>' + esc(msg.role) + '</code>' + agentSpan +
        '  · awaiting…' +
        '</div>' +
        '<div class="turn-prompt">' + esc(msg.prompt) + '</div>' +
        '<div class="turn-progress" data-progress></div>';
    } else if (msg.type === 'progress') {
      const t = ensureTurn(msg.taskId);
      const p = t.querySelector('[data-progress]');
      if (p) {
        const counts = (msg.totalSteps > 0)
          ? ' (' + msg.currentStep + '/' + msg.totalSteps + ')'
          : '';
        p.textContent = (msg.stepLabel || 'progress') + counts;
      }
    } else if (msg.type === 'complete') {
      const t = ensureTurn(msg.taskId);
      const cls = msg.blocked ? 'turn--blocked' : 'turn--complete';
      t.classList.add(cls);
      const blockedTag = msg.blocked
        ? ' · <span style="color:#ef6c00">BLOCKED</span> ' + esc(msg.blockReason || '')
        : '';
      const meta = t.querySelector('.turn-meta');
      if (meta) {
        meta.innerHTML = meta.innerHTML.replace(
          'awaiting…',
          'agent <code>' + esc(msg.agentId) + '</code> · ' +
          esc(String(Math.round(msg.latencyMs || 0))) + ' ms' + blockedTag,
        );
      }
      const progress = t.querySelector('[data-progress]');
      if (progress) progress.remove();
      const out = document.createElement('div');
      out.className = 'turn-output';
      out.textContent = msg.output || '(empty response)';
      t.appendChild(out);
    } else if (msg.type === 'error') {
      if (msg.taskId) {
        const t = ensureTurn(msg.taskId);
        t.classList.add('turn--error');
        const out = t.querySelector('.turn-output') || document.createElement('div');
        out.className = 'turn-output';
        out.textContent = msg.message;
        if (!t.contains(out)) t.appendChild(out);
        const progress = t.querySelector('[data-progress]');
        if (progress) progress.remove();
      } else {
        flashError(msg.message || 'Unknown error');
      }
    }
  });

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
</script>
</body>
</html>`;
}
