# ACC Podman Desktop Extension — Implementation Reference

**Status:** v0.1 complete on `main` after PR #6 ships. Local test
totals: 85/85 across 9 test files; `tsc` build clean.

This document records exactly how the v0.1 extension is built, the
boundaries between its modules, and the wire shapes its panels
exchange with their webviews.

> **PR numbering used in this document mirrors the GitHub PRs on
> [`flg77/acc-podman-desktop`](https://github.com/flg77/acc-podman-desktop):**
>
> | Plan PR | GitHub PR | Branch | Stack |
> |---|---|---|---|
> | PR #1 | scaffold (initial commit) | `main` (no PR) | — |
> | PR #2 | [#1](https://github.com/flg77/acc-podman-desktop/pull/1) | `feat/cluster-topology` | `main` |
> | PR #3 | [#4](https://github.com/flg77/acc-podman-desktop/pull/4) | `feat/examples-panel` | `main` |
> | PR #4 | [#5](https://github.com/flg77/acc-podman-desktop/pull/5) | `feat/manifest-browser` | `main` |
> | PR #5 | [#6](https://github.com/flg77/acc-podman-desktop/pull/6) | `feat/stack-panel` | `main` |
> | PR #6 | this PR | `docs/v0.1-closer` | `main` |

GitHub PR numbers and plan PR numbers diverged because GitHub
allocates IDs across the whole repo (issues + PRs combined); the
plan numbering follows BACKLOG.md.

---

## Why this extension

The ACC runtime ([agentic-cell-corpus](https://github.com/flg77/acc))
is operated today via a Textual TUI + `acc-cli`. Both work
flawlessly on the agent host, including over SSH. They do NOT live
inside the same drawer Red Hat developers already open daily —
that drawer is Podman Desktop, with AI Lab as the
local-LLM-serving extension.

The ACC extension closes that gap by living *next to* AI Lab as a
peer extension. Operators discover ACC inside PD, bring up a
governed multi-agent stack with one click, browse roles + skills +
MCPs without `find` + `cat`, watch the cluster topology live, and
run the two example demos from the Examples panel.

This extension is intentionally **a UI shim over the existing
runtime**: it never re-implements `acc-deploy.sh` or `acc-cli`; it
just wraps them in panels that consume the same NATS + filesystem
sources of truth.

---

## High-level architecture

```
                 Podman Desktop  (host)
   ┌─────────────────────────────────────────────────────┐
   │  ACC Podman Desktop extension                        │
   │   src/extension.ts  ── activate / deactivate         │
   │                                                      │
   │   ┌────────────┐   ┌────────────┐   ┌────────────┐  │
   │   │ Stack      │   │ Cluster    │   │ Examples   │  │
   │   │ panel      │   │ topology   │   │ panel      │  │
   │   │  (PR #5)   │   │  (PR #2)   │   │  (PR #3)   │  │
   │   └────┬───────┘   └─────┬──────┘   └─────┬──────┘  │
   │        │                 │                │         │
   │   ┌────────────┐   ┌────────────┐   ┌────────────┐  │
   │   │ Manifests  │   │ NATS sub   │   │ runScript  │  │
   │   │ browser    │   │ + decode   │   │ (spawn)    │  │
   │   │  (PR #4)   │   │            │   │            │  │
   │   └─────┬──────┘   └─────┬──────┘   └─────┬──────┘  │
   │         │                │                │         │
   └─────────┼────────────────┼────────────────┼─────────┘
             │                │                │
             ▼                ▼                ▼
       roles/, skills/,    NATS bus      acc-deploy.sh
        mcps/ on disk       (msgpack)    examples/*/run.sh
                            from the     etc.
                            arbiter
```

Each panel is a TypeScript module that registers a command, opens
a `WebviewPanel` on demand, and pushes/pulls messages over PD's
webview API. The webview HTML is inline in v0.1; PR #7+ may move
to a Svelte bundle if the panels grow.

---

## PR #2 — Cluster topology panel

**Files:** `src/cluster/aggregator.ts`, `src/cluster/subscriber.ts`,
`src/cluster/renderer.ts`, `src/cluster/topology.ts`,
`tests/aggregator.test.ts`, `tests/renderer.test.ts`,
`tests/subscriber.test.ts`.

### Aggregator

Pure-TS port of the runtime's `_update_cluster_topology` fold (in
`acc/tui/client.py`). Schema mirrors the runtime's
`CollectiveSnapshot.cluster_topology` exactly so the extension
and the TUI are byte-compatible.

```ts
class TopologyAggregator {
  ingest(payload: Record<string, unknown>): boolean;
  liveClusters(): TopologySnapshot;       // applies 30 s grace window
  reset(): void;
  get(): TopologySnapshot;
}
```

`extractSkillInUse(stepLabel)` parses canonical step labels:

| Step label | Returns |
|---|---|
| `"Calling skill:code_review"` | `"code_review"` |
| `"Calling mcp:fs.read"` | `"mcp:fs.read"` |
| `"Pre-reasoning gate (Cat-B)"` | `""` |

### NATS subscriber

`startSubscriber(aggregator, options)` — connects to NATS, subscribes
to `acc.{cid}.>`, decodes each frame from `msgpack(json bytes)`,
dispatches into the aggregator, debounces a re-render via
`onUpdate` callback.

`decodeFrame(data)` tolerates both:
* canonical `msgpack(<utf-8 JSON bytes>)` (PR #26 wire shape)
* direct-msgpack-of-object (forward-compat for any future runtime)

Returns `null` on malformed frames — telemetry is lossy; the
subscriber never throws out of its dispatch loop.

### Renderer

`renderSnapshot(snapshot, options)` — pure-function HTML.
Every operator-supplied string passes through `escapeHtml`
(`& < > " '`); XSS via untrusted role / skill / step_label is
bounded.

Render shape mirrors the TUI's prompt-pane cluster panel:

```
▼ Clusters: 1 (Σ 3 agents)
  c-abc12345 · coding_agent · 3 agents · fixed strategy, count=3
    ● coding_agent-aaa · skill:code_review · step 2/4 · running (iter 1)
    ● coding_agent-bbb · skill:test_genera · step 3/4 · running
    ● coding_agent-ccc · skill:echo        · step 4/4 · complete
```

### topology.ts wiring

- Registers `acc.cluster.show` command.
- On invocation: creates a `WebviewPanel`, starts the subscriber,
  drives a 100 ms debounced re-render plus a 5 s periodic re-paint
  (so the 30 s grace window can drop finished clusters even when
  no new wire events arrive).
- Subscriber teardown on panel dispose.

---

## PR #3 — Examples panel

**Files:** `src/examples/runner.ts`,
`src/examples/verification.ts`, `src/examples/panel.ts`,
`tests/runner.test.ts`, `tests/verification.test.ts`.

### Runner

Pure-TS spawn wrapper used by every panel that shells a command:

```ts
runScript({
  command: '<path>',
  args: ['--topic', 'agentic-ai-strategy'],
  cwd: '<repo root>',
  env: { CUSTOM: '1' },
  onChunk: (kind, text) => /* live tail */
}): RunnerHandle
```

* Streams stdout/stderr via `onChunk`.
* `kind` discriminates streams; the panel renders stderr in a warning colour.
* Listener exception isolation — a buggy `onChunk` cannot crash the
  spawn.
* `kill()` sends SIGTERM, then SIGKILL after 2 s.
* Cross-platform: `shell: true` on Windows so `.bat` / WSL `.sh`
  invocations work through cmd; direct execve on Unix.

### Verification reader

`acc/research/citation_verifier.py` (runtime) writes
`runs/<topic-slug>-<date>/.verification.json` after `verify.sh`.
The extension reads + formats it for the panel:

```ts
readVerification(runDir): Promise<VerificationReport | undefined>;
formatVerification(report): FormattedVerification;
```

Tolerates: missing file, malformed JSON, payloads missing required
fields. A missing-citations report is *not* OK regardless of
threshold (a report without sourcing is itself a critic failure).

### Panel

`acc.examples.show` opens a webview with two cards: coding-split
and autoresearcher. The autoresearcher card has a topic-slug input
that becomes `--topic <slug>` on the outbound `run.sh`.

Bidirectional message protocol:

| webview → host | Effect |
|---|---|
| `{ type: 'run', example, topic? }` | shells `examples/<dir>/run.sh` |
| `{ type: 'verify', example }` | shells `verify.sh`; reads `.verification.json` |
| `{ type: 'clean', example }` | shells `clean.sh` |
| `{ type: 'kill', example }` | runner.kill() — cooperative SIGTERM |

| host → webview | Effect |
|---|---|
| `{ type: 'log', example, kind, text }` | append chunk to log pane |
| `{ type: 'state', example, running }` | toggle button states |
| `{ type: 'verification', example, report }` | render coloured headline + bullet card |

The panel sniffs a `Run dir: <path>` line out of `run.sh` stdout so
the Verify button can find the right `runs/<topic>-<date>/`.

---

## PR #4 — Manifest browser

**Files:** `src/manifests/loader.ts`,
`src/manifests/open-in-editor.ts`, `src/manifests/panel.ts`,
`tests/manifests-loader.test.ts`.

### Loader

Pure-fs YAML reader for `roles/<name>/role.yaml`,
`skills/<name>/skill.yaml`, `mcps/<name>/mcp.yaml`.

```ts
loadRoles(repoRoot): Promise<RoleSummary[]>;
loadSkills(repoRoot): Promise<SkillSummary[]>;
loadMcps(repoRoot): Promise<McpSummary[]>;
```

Tolerant:
* Missing fields default (e.g. `max_skill_risk_level → "MEDIUM"`).
* Unparseable YAML: directory dropped from the result.
* `_base` / `TEMPLATE` directories filtered out (runtime uses these
  as inheritance templates).
* File-presence flags on every summary so the panel knows whether
  to render an "Open" button per file.

### Open-in-editor

`openInEditor(filePath)` — detached spawn:

| Order | What |
|---|---|
| 1 | `$EDITOR` (operator's explicit choice) |
| 2 | Platform default (`open` on macOS, `start ""` on Windows, `xdg-open` on Linux) |

`detached: true` + `child.unref()` so the panel doesn't block on
the editor.

### Panel

`acc.manifests.show` opens a three-tab webview (Roles / Skills /
MCPs) with live counters, risk pills (LOW / MEDIUM / HIGH /
CRITICAL colour-coded), detail pane on row select, "Open in
editor" buttons per file.

| webview → host | Effect |
|---|---|
| `{ type: 'refresh' }` | reload manifests + re-render |
| `{ type: 'open', path }` | hand path to system editor |

| host → webview | Effect |
|---|---|
| `{ type: 'data', roles, skills, mcps }` | populate tabs |
| `{ type: 'opened', path, command }` | toast |
| `{ type: 'error', message }` | red error banner |

**Read-only by design.** The extension never authors a manifest;
the runtime's `acc-cli role lint` + the operator's editor are the
canonical authoring surface.

---

## PR #5 — Stack provisioning panel

**Files:** `src/stack/env-file.ts`, `src/stack/status.ts`,
`src/stack/panel.ts`, `tests/env-file.test.ts`,
`tests/stack-status.test.ts`. (Existing
`src/stack/commands.ts` from PR #1 stays as a fallback for
operators who prefer the command palette.)

### env-file ops

```ts
listPresets(repoRoot): Promise<PresetSummary[]>;
readDeployEnv(repoRoot): Promise<DeployEnv>;
writeDeployEnv(repoRoot, contents): Promise<string>;
applyPreset(repoRoot, presetName): Promise<ApplyPresetResult>;
readProfileState(envContents): ProfileState;
patchProfileState(envContents, state): string;
```

`applyPreset` mirrors `env/use.sh` exactly: copies
`env/.env.<name>` → `deploy/.env`, backing up any existing file
as `.bak`. Operators using either path see the same effect.

`patchProfileState` is **conservative**: existing
`KEY=VALUE` lines update in place; missing keys append at the end
under a marker comment; comments and non-profile lines are never
touched.

### Status

`parsePodmanPs(jsonText)` filters `podman ps --format json` rows
to `acc-*` names. Pure function; schema-tolerant. Live wrapper
returns `[]` when podman is missing rather than crashing.

### Panel

`acc.stack.show` — single panel with four sections:

1. **Lifecycle row** — Up / Down / Rebuild / Status buttons +
   live log + Stop button.
2. **Containers table** — `acc-*` containers with state pill;
   refreshes every 5 s.
3. **Profiles** — five checkboxes (TUI / CODING_SPLIT /
   AUTORESEARCHER / MCP_ECHO / DETACH); "Save profiles" patches
   `deploy/.env`.
4. **`deploy/.env` editor** — preset dropdown + textarea +
   Save button.

Same runner (PR #3) for live tail + Stop button.

| webview → host | Effect |
|---|---|
| `{ type: 'refresh' }` | reload presets / env / containers |
| `{ type: 'up' \| 'down' \| 'rebuild' \| 'status' }` | shell `acc-deploy.sh <cmd>` |
| `{ type: 'apply-preset', preset }` | copy `env/.env.<preset>` → `deploy/.env` (with .bak) |
| `{ type: 'save-env', contents }` | write textarea contents to `deploy/.env` |
| `{ type: 'save-profiles', state }` | patch profile lines in `deploy/.env` |
| `{ type: 'kill' }` | runner.kill() |

| host → webview | Effect |
|---|---|
| `{ type: 'data', presets, env, profiles, containers }` | full panel re-render |
| `{ type: 'state', running }` | toggle button states |
| `{ type: 'log', kind, text }` | live tail |
| `{ type: 'toast', message, kind }` | corner notification |

---

## File map (v0.1)

```
src/
├── extension.ts                    activate / deactivate; wires every
│                                   panel + command set
├── core/
│   ├── logger.ts                   Logger interface + consoleLogger
│   └── paths.ts                    resolve operator's ACC install
├── stack/
│   ├── commands.ts (PR #1)         acc.stack.up/down/status as commands
│   ├── env-file.ts (PR #5)         deploy/.env + env/.env.* ops
│   ├── status.ts (PR #5)           podman ps wrapper
│   └── panel.ts (PR #5)            rich provisioning UI
├── cluster/
│   ├── aggregator.ts (PR #2)       pure-TS topology fold
│   ├── subscriber.ts (PR #2)       NATS lifecycle + msgpack decode
│   ├── renderer.ts (PR #2)         pure-function HTML emit
│   └── topology.ts (PR #2)         webview wiring + 5 s re-paint
├── examples/
│   ├── registry.ts (PR #1)         command-only example runners
│   ├── runner.ts (PR #3)           shared spawn wrapper (panel + commands)
│   ├── verification.ts (PR #3)     read .verification.json
│   └── panel.ts (PR #3)            two-card example panel
└── manifests/
    ├── loader.ts (PR #4)           YAML loader
    ├── open-in-editor.ts (PR #4)   $EDITOR / platform default
    └── panel.ts (PR #4)            three-tab browser

tests/
├── _mocks/podman-desktop-api.ts    settable in-memory PD API stub
├── paths.test.ts                   4 cases
├── aggregator.test.ts              16 cases
├── renderer.test.ts                12 cases
├── subscriber.test.ts              5 cases
├── runner.test.ts                  4 cases
├── verification.test.ts            8 cases
├── manifests-loader.test.ts        12 cases
├── env-file.test.ts                18 cases
└── stack-status.test.ts            6 cases
```

**Total: ~2 000 LOC of TypeScript, 85 unit tests.**

---

## Test matrix (local Windows env, Node 20)

| File | Cases | Result |
|---|---:|---|
| `paths.test.ts` | 4 | 4/4 |
| `aggregator.test.ts` | 16 | 16/16 |
| `renderer.test.ts` | 12 | 12/12 |
| `subscriber.test.ts` | 5 | 5/5 |
| `runner.test.ts` | 4 | 4/4 |
| `verification.test.ts` | 8 | 8/8 |
| `manifests-loader.test.ts` | 12 | 12/12 |
| `env-file.test.ts` | 18 | 18/18 |
| `stack-status.test.ts` | 6 | 6/6 |
| **Total** | **85** | **85/85** |

`tsc` build clean across every PR.

---

## Commands the extension registers (v0.1)

| Command | Surface | Effect |
|---|---|---|
| `acc.stack.show` | panel | opens stack provisioning panel (PR #5) |
| `acc.stack.up` | command palette | shells `acc-deploy.sh up` |
| `acc.stack.down` | command palette | shells `acc-deploy.sh down` |
| `acc.stack.status` | command palette | shells `acc-deploy.sh status` |
| `acc.cluster.show` | panel | opens cluster topology panel (PR #2) |
| `acc.examples.show` | panel | opens examples runner panel (PR #3) |
| `acc.examples.coding-split` | command palette | runs the coding-split demo |
| `acc.examples.autoresearcher` | command palette | runs the autoresearcher demo |
| `acc.manifests.show` | panel | opens roles/skills/MCPs browser (PR #4) |

---

## Wire-protocol cheat sheet

The extension consumes (never emits) these wire shapes:

### NATS payloads (cluster topology)

```json
{ "signal_type": "TASK_PROGRESS",
  "cluster_id":  "c-abc12345",
  "agent_id":    "coding_agent-aaa",
  "task_id":     "...",
  "iteration_n": 0,
  "progress":    { "current_step": 2, "total_steps_estimated": 6,
                   "step_label": "Calling skill:code_review" } }
```

```json
{ "signal_type": "TASK_COMPLETE",
  "cluster_id":  "c-abc12345",
  "agent_id":    "coding_agent-aaa",
  "task_id":     "...",
  "blocked":     false,
  "tokens_used": 4250 }
```

Wire-format wrapping: `msgpack(<utf-8 JSON bytes>)` per
`acc/backends/signaling_nats.py`. The decoder also accepts
direct-msgpack-of-object as a forward-compat fallback.

### Filesystem shapes (manifest browser)

```yaml
# roles/<name>/role.yaml
role_definition:
  purpose: "..."
  persona: "analytical"
  domain_id: "..."
  domain_receptors: [...]
  max_parallel_tasks: 3
  default_skills: [...]
  allowed_skills: [...]
  max_skill_risk_level: "MEDIUM"
  default_mcps: [...]
  allowed_mcps: [...]
  max_mcp_risk_level: "HIGH"
  estimator:
    strategy: "heuristic"
```

```yaml
# skills/<name>/skill.yaml
purpose: "..."
version: "0.1.0"
risk_level: "LOW"
domain_id: "..."
tags: [...]
```

```yaml
# mcps/<name>/mcp.yaml
purpose: "..."
transport: "http"
risk_level: "MEDIUM"
domain_id: "..."
allowed_tools: [...]
```

### env-file shapes (stack panel)

`deploy/.env` is consumed verbatim by the compose file's
`env_file:` directive; the panel updates `KEY=VALUE` lines for
the five profile keys (`TUI`, `CODING_SPLIT`, `AUTORESEARCHER`,
`MCP_ECHO`, `DETACH`) without touching anything else.

`env/.env.<name>` files are operator-shareable presets — each
documents one model backend's connection vars + a `# Preset for …`
blurb the panel reads as the dropdown label.

---

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `acc.repoPath` | auto-detect | Filesystem path to the agentic-cell-corpus repo. |
| `acc.collectiveId` | `sol-01` | NATS subject prefix for cluster topology. |
| `acc.natsUrl` | `nats://localhost:4222` | NATS endpoint for the cluster panel. |

Auto-detection walks (in order): configured path → `~/`,
`~/git/`, `~/src/`, `~/Downloads/git/agentic/` looking for an
`agentic-cell-corpus` checkout.

---

## What v0.1 deliberately doesn't do

* **Author manifests in a built-in editor.** Authoring stays in
  the operator's editor of choice.
* **Re-implement Podman Desktop's container management.** PD owns
  that fully.
* **Run the ACC runtime itself.** This extension is a UI shim
  over `acc-deploy.sh` + `acc-cli`.
* **Compete with Kaiden.** Kaiden is for solo single-agent
  development; ACC is for governed multi-agent fleets. The
  optional Kaiden import in v0.2 is migration-helper, not
  feature-replacement.
* **Local model serving.** AI Lab owns that. The v0.2 cross-
  extension bridge will detect AI Lab Model Services and offer
  one-click `ACC_OPENAI_BASE_URL` wiring.

---

## v0.2 backlog (next iterations)

See [`BACKLOG.md`](../BACKLOG.md) for the full v0.2 plan:

* PR #7 — AI Lab Model Service auto-detect (cross-extension
  highlight feature)
* PR #8 — Compliance dashboard (mirrors TUI screen 3)
* PR #9 — Performance dashboard (per-skill / per-MCP stats +
  cost-cap progress bar)
* PR #10 — Optional Kaiden MCP import (one-way migration helper)

---

## See also

* [`BACKLOG.md`](../BACKLOG.md) — PR plan past v0.1.
* [`README.md`](../README.md) — operator-facing intro.
* [`docs/DEMO_PD_extension.md`](DEMO_PD_extension.md) — phase-by-phase
  walkthrough.
* [`flg77/acc`](https://github.com/flg77/acc)
  — the runtime this extension consumes:
  * `docs/IMPLEMENTATION_subagent_clustering.md` — cluster wire shapes.
  * `docs/AUTORESEARCHER_implementation.md` — autoresearcher
    demo's iteration loop.
* `ACC Podman Desktop Plan.md` — strategic plan in the operator's
  Obsidian repo (private).
