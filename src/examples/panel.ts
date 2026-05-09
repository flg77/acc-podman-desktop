/**
 * Examples panel — webview that lists the runnable example
 * scenarios with Run / Verify / Clean buttons + a topic-slug
 * input for the autoresearcher.
 *
 * Bidirectional message protocol with the webview:
 *   webview → host:
 *     { type: 'run',     example: '<id>', topic?: string }
 *     { type: 'verify',  example: '<id>' }
 *     { type: 'clean',   example: '<id>' }
 *     { type: 'kill',    example: '<id>' }
 *   host → webview:
 *     { type: 'log',           example: '<id>', kind: 'stdout'|'stderr', text: string }
 *     { type: 'state',         example: '<id>', running: boolean }
 *     { type: 'verification',  example: '<id>', report: FormattedVerification }
 *
 * The panel is the v0.0.3 replacement for the command-only
 * access PR #1 shipped — operators can run / verify / clean
 * without leaving Podman Desktop.
 */

import * as path from 'node:path';

import * as extensionApi from '@podman-desktop/api';

import type { AccPaths } from '../core/paths';
import type { Logger } from '../core/logger';
import { runScript, type RunnerHandle } from './runner';
import {
  formatVerification,
  readVerification,
  type FormattedVerification,
} from './verification';


export interface ExampleSpec {
  id: 'coding-split' | 'autoresearcher';
  label: string;
  blurb: string;
  exampleDir: string;
  /** Set when the example uses --topic <slug>. */
  topicAware: boolean;
}


export const EXAMPLES: readonly ExampleSpec[] = [
  {
    id: 'coding-split',
    label: 'Coding Split with Skills',
    blurb:
      'Five-persona PLAN: architect → implementer cluster → tester + reviewer + dependency_audit.  Heuristic estimator-driven cluster fan-out.',
    exampleDir: 'examples/coding_split_skills',
    topicAware: false,
  },
  {
    id: 'autoresearcher',
    label: 'ACC Autoresearcher',
    blurb:
      'Six-persona research plan with iteration loop + critic-driven NEEDS_REVISE re-issues.  Real web research via browser-harness + Brave + fetch.  Output lands at runs/<topic>-<date>/.',
    exampleDir: 'examples/acc_autoresearcher',
    topicAware: true,
  },
] as const;


interface PanelState {
  paths: AccPaths | undefined;
  log: Logger;
  webview: extensionApi.WebviewPanel | undefined;
  /** Per-example active runner — only one process per id at once. */
  runners: Map<string, RunnerHandle>;
  /** Most recent run dir per example, used by Verify + Clean. */
  lastRunDir: Map<string, string>;
  /** Buffer for "Run dir: <path>" lines sniffed out of run.sh stdout. */
  runDirSniffed: Map<string, string>;
}


export function registerExamplesPanel(
  paths: AccPaths | undefined,
  log: Logger,
): extensionApi.Disposable[] {
  const state: PanelState = {
    paths,
    log,
    webview: undefined,
    runners: new Map(),
    lastRunDir: new Map(),
    runDirSniffed: new Map(),
  };

  const showCommand = extensionApi.commands.registerCommand(
    'acc.examples.show',
    async () => {
      try {
        await openPanel(state);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`examples.show failed: ${msg}`);
        extensionApi.window.showErrorMessage(
          `ACC examples panel failed to open: ${msg}`,
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
    'acc.examples',
    'ACC Examples',
  );
  state.webview = panel;
  panel.webview.html = renderInitialHtml();

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
    const exampleId = String(msg['example'] ?? '');
    const example = EXAMPLES.find((e) => e.id === exampleId);
    if (example === undefined) {
      return;
    }

    try {
      if (type === 'run') {
        const topic = msg['topic'] !== undefined
          ? String(msg['topic'])
          : undefined;
        await dispatchRun(state, example, topic);
      } else if (type === 'verify') {
        await dispatchVerify(state, example);
      } else if (type === 'clean') {
        await dispatchClean(state, example);
      } else if (type === 'kill') {
        const r = state.runners.get(exampleId);
        if (r !== undefined) {
          r.kill();
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      state.log.error(`examples panel: ${type} for ${exampleId}: ${errMsg}`);
      void postLog(state, exampleId, 'stderr', `\nERROR: ${errMsg}\n`);
    }
  });
}


async function dispatchRun(
  state: PanelState,
  example: ExampleSpec,
  topic: string | undefined,
): Promise<void> {
  if (state.paths === undefined) {
    void postLog(state, example.id, 'stderr',
      'ACC repo not configured.  Set "acc.repoPath" in settings.\n');
    return;
  }
  if (state.runners.get(example.id)?.isRunning()) {
    void postLog(state, example.id, 'stderr',
      'A run for this example is already in progress.\n');
    return;
  }

  const runScriptPath = path.join(
    state.paths.repoPath,
    example.exampleDir,
    'run.sh',
  );
  const args: string[] = [];
  if (example.topicAware && topic && topic.trim()) {
    args.push('--topic', topic.trim());
  }

  void postState(state, example.id, true);
  void postLog(state, example.id, 'stdout',
    `▶ ${runScriptPath} ${args.join(' ')}\n`);

  const handle = runScript$invoke(state, example.id, runScriptPath, args);
  state.runners.set(example.id, handle);
  const code = await handle.promise;

  void postState(state, example.id, false);
  void postLog(state, example.id, 'stdout', `\n[exit ${code}]\n`);

  // Note the most recent run dir so the Verify button can find it.
  // run.sh prints "▶ Run dir: runs/<topic>-<date>" — capture that
  // line via a slightly hacky regex on the buffered output.  PR #4
  // (richer panel) introduces a structured event channel via
  // ACC_RUN_OUTPUT_DIR being echoed back as JSON.
  const runDir = state.runDirSniffed.get(example.id);
  if (runDir !== undefined) {
    state.lastRunDir.set(example.id, runDir);
  }
}


async function dispatchVerify(
  state: PanelState,
  example: ExampleSpec,
): Promise<void> {
  if (state.paths === undefined) {
    void postLog(state, example.id, 'stderr',
      'ACC repo not configured.\n');
    return;
  }
  const verifyScript = path.join(
    state.paths.repoPath,
    example.exampleDir,
    'verify.sh',
  );
  void postState(state, example.id, true);
  void postLog(state, example.id, 'stdout', `▶ ${verifyScript}\n`);

  const handle = runScript$invoke(state, example.id, verifyScript, []);
  state.runners.set(example.id, handle);
  const code = await handle.promise;
  void postState(state, example.id, false);
  void postLog(state, example.id, 'stdout', `\n[exit ${code}]\n`);

  // Surface the parsed verification report back to the webview
  // so the panel can render the headline + details cards.
  const runDir = state.lastRunDir.get(example.id);
  if (runDir !== undefined) {
    const raw = await readVerification(runDir);
    if (raw !== undefined) {
      void postVerification(state, example.id, formatVerification(raw));
    }
  }
}


async function dispatchClean(
  state: PanelState,
  example: ExampleSpec,
): Promise<void> {
  if (state.paths === undefined) {
    void postLog(state, example.id, 'stderr',
      'ACC repo not configured.\n');
    return;
  }
  const cleanScript = path.join(
    state.paths.repoPath,
    example.exampleDir,
    'clean.sh',
  );
  void postState(state, example.id, true);
  void postLog(state, example.id, 'stdout', `▶ ${cleanScript}\n`);

  const handle = runScript$invoke(state, example.id, cleanScript, []);
  state.runners.set(example.id, handle);
  const code = await handle.promise;
  void postState(state, example.id, false);
  void postLog(state, example.id, 'stdout', `\n[exit ${code}]\n`);
}


// ---------------------------------------------------------------------------
// Helpers — webview message senders + the spawn wrapper
// ---------------------------------------------------------------------------


/**
 * Spawns a script and pipes stdout/stderr into the panel.  Wraps
 * the pure runner in panel-aware bookkeeping (run-dir sniffing,
 * map updates).
 */
function runScript$invoke(
  state: PanelState,
  exampleId: string,
  command: string,
  args: readonly string[],
): RunnerHandle {
  return runScript({
    command,
    args,
    cwd: state.paths!.repoPath,
    onChunk: (kind, text) => {
      // Sniff a "Run dir: <path>" line so the Verify button can
      // find the right `runs/<topic>-<date>/` even when run.sh
      // didn't get an explicit ACC_RUN_OUTPUT_DIR override.
      const m = text.match(/Run dir:\s*(\S+)/);
      if (m !== null && m[1]) {
        state.runDirSniffed.set(exampleId, m[1]);
      }
      void postLog(state, exampleId, kind, text);
    },
  });
}


async function postLog(
  state: PanelState,
  exampleId: string,
  kind: 'stdout' | 'stderr',
  text: string,
): Promise<void> {
  if (state.webview === undefined) {
    return;
  }
  try {
    await state.webview.webview.postMessage({
      type: 'log',
      example: exampleId,
      kind,
      text,
    });
  } catch {
    // Webview may have closed mid-write; runner keeps going.
  }
}


async function postState(
  state: PanelState,
  exampleId: string,
  running: boolean,
): Promise<void> {
  if (state.webview === undefined) {
    return;
  }
  try {
    await state.webview.webview.postMessage({
      type: 'state',
      example: exampleId,
      running,
    });
  } catch {
    // best-effort
  }
}


async function postVerification(
  state: PanelState,
  exampleId: string,
  report: FormattedVerification,
): Promise<void> {
  if (state.webview === undefined) {
    return;
  }
  try {
    await state.webview.webview.postMessage({
      type: 'verification',
      example: exampleId,
      report,
    });
  } catch {
    // best-effort
  }
}


// ---------------------------------------------------------------------------
// Initial HTML — single-shot render; subsequent updates flow via
// postMessage.
// ---------------------------------------------------------------------------


function renderInitialHtml(): string {
  const cardsHtml = EXAMPLES.map(renderCard).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ACC Examples</title>
<style>
  body { font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         padding: 1rem; background: #1a1a2e; color: #eee; margin: 0; }
  h1   { font-size: 1.1rem; margin: 0 0 1rem 0; }
  .acc-card { background: #232342; border-left: 3px solid #4a90e2;
              border-radius: 4px; padding: 1rem; margin-bottom: 1rem; }
  .acc-card h2 { font-size: 1rem; margin: 0 0 0.4rem 0; }
  .acc-card p  { color: #aaa; margin: 0 0 0.75rem 0; }
  .acc-actions { display: flex; gap: 0.5rem; flex-wrap: wrap;
                 align-items: center; margin-bottom: 0.5rem; }
  .acc-topic-input { padding: 4px 8px; border-radius: 3px;
                     border: 1px solid #444; background: #15152a;
                     color: #eee; font: inherit; min-width: 18ch; }
  button { background: #4a90e2; color: white; border: 0; padding: 6px 14px;
           border-radius: 3px; cursor: pointer; font: inherit; }
  button:hover { background: #5aa0f2; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.acc-secondary { background: #444; }
  button.acc-secondary:hover { background: #555; }
  button.acc-danger { background: #ef5350; }
  .acc-status { display: inline-block; min-width: 9ch; font-size: 0.85rem;
                color: #888; padding-left: 0.5rem; }
  .acc-status--running { color: #ffd54f; }
  .acc-verification { margin-top: 0.5rem; padding: 0.5rem 0.75rem;
                      border-radius: 3px; }
  .acc-verification--ok { background: #1f3d2c; border-left: 3px solid #4caf50; }
  .acc-verification--fail { background: #3d1f1f; border-left: 3px solid #ef5350; }
  .acc-log { background: #0e0e1c; padding: 0.5rem 0.75rem;
             font: 11px/1.4 ui-monospace, SFMono-Regular, monospace;
             white-space: pre-wrap; word-break: break-word;
             max-height: 12rem; overflow-y: auto; border-radius: 3px;
             margin-top: 0.5rem; }
  .acc-log .acc-log-stderr { color: #ffab91; }
</style>
</head>
<body>
<h1>ACC Examples</h1>
${cardsHtml}
<script>
  const vscode = acquireVsCodeApi ? acquireVsCodeApi() : null;
  const post = (msg) => vscode ? vscode.postMessage(msg) : window.parent?.postMessage(msg, '*');

  // Per-example state: log buffer, running flag, verification report.
  const cards = {};
  document.querySelectorAll('[data-example]').forEach((el) => {
    const id = el.dataset.example;
    cards[id] = {
      el,
      logEl: el.querySelector('.acc-log'),
      statusEl: el.querySelector('.acc-status'),
      verifyEl: el.querySelector('.acc-verification'),
      runBtn: el.querySelector('button[data-action="run"]'),
      verifyBtn: el.querySelector('button[data-action="verify"]'),
      cleanBtn: el.querySelector('button[data-action="clean"]'),
      killBtn: el.querySelector('button[data-action="kill"]'),
      topicInput: el.querySelector('.acc-topic-input'),
    };

    cards[id].runBtn.addEventListener('click', () => {
      const topic = cards[id].topicInput?.value || undefined;
      post({ type: 'run', example: id, topic });
    });
    cards[id].verifyBtn.addEventListener('click', () =>
      post({ type: 'verify', example: id }));
    cards[id].cleanBtn.addEventListener('click', () =>
      post({ type: 'clean', example: id }));
    cards[id].killBtn?.addEventListener('click', () =>
      post({ type: 'kill', example: id }));
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    const card = cards[msg.example];
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
      card.runBtn.disabled = msg.running;
      card.verifyBtn.disabled = msg.running;
      card.cleanBtn.disabled = msg.running;
      if (card.killBtn) card.killBtn.disabled = !msg.running;
    } else if (msg.type === 'verification') {
      const r = msg.report;
      card.verifyEl.className = 'acc-verification ' +
        (r.ok ? 'acc-verification--ok' : 'acc-verification--fail');
      card.verifyEl.innerHTML =
        '<strong>' + escapeHtml(r.headline) + '</strong>' +
        '<ul>' + r.details.map((d) => '<li>' + escapeHtml(d) + '</li>').join('') + '</ul>';
    }
  });

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
</script>
</body>
</html>`;
}


function renderCard(example: ExampleSpec): string {
  const topicInput = example.topicAware
    ? `<label>Topic: <input class="acc-topic-input" data-example="${example.id}" placeholder="agentic-ai-strategy" /></label>`
    : '';
  return `
<section class="acc-card" data-example="${example.id}">
  <h2>${escapeHtml(example.label)}</h2>
  <p>${escapeHtml(example.blurb)}</p>
  <div class="acc-actions">
    ${topicInput}
    <button data-action="run">Run</button>
    <button data-action="verify" class="acc-secondary">Verify</button>
    <button data-action="clean" class="acc-secondary">Clean</button>
    <button data-action="kill" class="acc-danger" disabled>Stop</button>
    <span class="acc-status"></span>
  </div>
  <div class="acc-verification"></div>
  <pre class="acc-log"></pre>
</section>`;
}


function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
