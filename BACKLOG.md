# BACKLOG — v0.1 + v0.2 PR plan

This is the running PR plan for the extension.  Mirrors the
six-PR shape we used for the cluster + autoresearcher work in
the runtime repo.

## v0.1 — Foundational extension surface (~3-4 weeks)

### PR #1 — Scaffold (this PR)

- [x] `package.json` extension manifest with command contributions
- [x] `tsconfig.json`
- [x] `src/extension.ts` activation + lifecycle
- [x] `src/core/paths.ts` — locate operator's ACC install
- [x] `src/stack/commands.ts` — stack lifecycle commands
- [x] `src/cluster/topology.ts` — topology stub (renders "coming in PR #2")
- [x] `src/examples/registry.ts` — runnable demo commands
- [x] `tests/paths.test.ts` — vitest smoke
- [x] `README.md` + `BACKLOG.md` + `LICENSE`

### PR #2 — Cluster topology panel ✅

- [x] NATS subscription via `nats` npm package against
      `acc.{cid}.>` (`src/cluster/subscriber.ts`).
- [x] Webview-rendered topology — pure-HTML render mirroring the
      TUI prompt pane's cluster panel.  Svelte upgrade deferred
      to PR #3.
- [x] Per-cluster row showing members + skill_in_use +
      iteration_n (PR #41 fields).
- [x] 30 s grace window for finished clusters (parity with TUI).
- [x] Tests — 37 cases across aggregator + renderer + subscriber
      + paths.

**Status:** ✅ landed.  37/37 tests green; tsc build clean.

### PR #3 — Examples panel (proper UI) ✅

- [x] Replace command-only access with a left-nav panel that
      lists each example with Run / Verify / Clean buttons
      (`src/examples/panel.ts`).
- [x] Topic-slug input modal for the autoresearcher example —
      inline `<input>` per-card; passed as `--topic <slug>` to
      `run.sh`.
- [x] Live tail of stdout/stderr inside the panel via
      `panel.webview.postMessage` events.
- [x] Surface `verify.sh` JSON output post-run — reads
      `runs/<topic>-<date>/.verification.json` via
      `src/examples/verification.ts`, formats it, posts a
      structured `type: 'verification'` message the panel
      renders as a coloured headline + bullet details card.
- [x] Stop button per running example (cooperative SIGTERM →
      SIGKILL after 2 s).
- [x] Pure-TS `runScript` wrapper (`src/examples/runner.ts`) —
      reusable across panel + standalone commands; isolated
      onChunk listener exceptions; cross-platform spawn (shell
      mode on Windows for `.bat` / WSL `.sh`).
- [x] Tests — 12 new cases across runner (4) + verification
      (8); 49/49 across the full suite.

**Status:** ✅ landed.  PR #4 (Role/Skill/MCP browser) builds
on the same panel + message-passing pattern.

### PR #4 — Role / Skill / MCP browser ✅

- [x] Three list views populated from the runtime repo's
      `roles/`, `skills/`, `mcps/` (`src/manifests/loader.ts`,
      `src/manifests/panel.ts`).
- [x] Click a role → render persona, domain, max_parallel_tasks,
      estimator strategy, default_skills, allowed_skills,
      max_skill_risk_level, default_mcps, allowed_mcps,
      max_mcp_risk_level + per-file "Open in editor" buttons.
- [x] "Open in editor" — `$EDITOR` first; falls back to
      platform defaults (`open` / `start ""` / `xdg-open`).
- [x] Read-only — the panel surfaces manifests; authoring
      stays in the operator's editor.
- [x] Tabs (Roles / Skills / MCPs) with live counters; risk
      pills coloured per LOW/MEDIUM/HIGH/CRITICAL.
- [x] YAML parsing via the `yaml` npm package; tolerant of
      missing fields; unparseable manifests skipped silently.
- [x] Tests — 12 new cases across the loader.

**Status:** ✅ landed.  61/61 across the full suite; tsc clean.

### PR #5 — Stack provisioning panel (rich UI) ✅

- [x] First-class panel replacing command-only access for
      `acc-deploy.sh up / down / rebuild / status`
      (`src/stack/panel.ts`).
- [x] Live container status — `podman ps --format json`
      filtered to `acc-*`, refreshed every 5 s
      (`src/stack/status.ts`).
- [x] Profile toggles for TUI / CODING_SPLIT / AUTORESEARCHER /
      MCP_ECHO / DETACH; "Save profiles" patches `deploy/.env`
      conservatively (preserves comments, never deletes
      unrelated lines).
- [x] Inline `deploy/.env` editor with the preset dropdown
      that mirrors `env/use.sh` exactly (existing `deploy/.env`
      backed up as `.bak` before overwrite).
- [x] One-click rebuild flow.
- [x] Live stdout/stderr tail of every command in the panel's
      log view; per-command Stop button (cooperative SIGTERM).
- [x] Tests — 24 new cases across `env-file` (18) +
      `stack-status` (6).

**Status:** ✅ landed.  85/85 across the full suite; tsc clean.

### PR #6 — Documentation closer ✅

- [x] `docs/EXTENSION_implementation.md` — wire-protocol +
      module reference (~570 lines; per-PR module breakdown,
      file map, test matrix, configuration table, anti-list).
- [x] `docs/DEMO_PD_extension.md` — operator walkthrough
      (six-phase: install → up → topology → demos → manifests →
      teardown; anti-checks + troubleshooting matrix).
- [ ] Update the runtime repo's `INDEX_*.md` to cross-link
      (deferred to a follow-up PR on the runtime repo).

**Status:** ✅ landed.  Closes v0.1.

## v0.2 — Cross-extension + governance dashboards (~2-3 weeks)

### PR #7 — AI Lab Model Service auto-detect ✅

- [x] Discover running AI Lab Model Services.  AI Lab does NOT
      expose a typed extension API today (`activate()` returns
      void; no public commands).  Primary path: hit AI Lab's
      local REST server `GET http://localhost:10434/api/v1/ps`
      (`src/ailab/discovery.ts`).
- [x] Fallback path: `podman ps --format json` filtered to
      containers labelled `ai-lab.model-id` (legacy
      `ai-studio.model-id` also accepted).
- [x] One-click "Wire to deploy/.env as ACC_OPENAI_BASE_URL"
      action — patches `ACC_LLM_BACKEND=openai_compat`,
      `ACC_OPENAI_BASE_URL=<url>`, `ACC_OPENAI_MODEL=<name>`
      conservatively (preserves comments + unrelated lines;
      updates existing assignments in place; never deletes).
- [x] Manual URL entry input when AI Lab not running.
- [x] Tests — 21 new cases across discovery (15) + wire-env (6).

**Status:** ✅ landed.  106/106 across the full suite; tsc clean.
File a feature request upstream for an
`ai-lab.inferenceServer.list` typed command if a non-REST path
becomes preferable later.

### PR #8 — Compliance dashboard ✅

- [x] OWASP violation log — `EVAL_OUTCOME` payload's
      `owasp_violations[]` folded into a 50-entry rolling log
      (`src/compliance/aggregator.ts`); per-LLM-code count table
      always renders all ten OWASP-LLM rows so "no violations"
      reads as a positive.
- [x] Oversight queue with approve / reject buttons — sourced
      from arbiter `HEARTBEAT.oversight_pending_items`; click
      publishes `OVERSIGHT_DECISION` on
      `acc.{cid}.oversight.{oversight_id}` (msgpack-of-JSON
      wire-format parity with the TUI).
- [x] Cat-A / Cat-B trigger summary per agent — `ALERT_ESCALATE`
      reasons matched on `cat_a` / `cat-a` (parity with
      `acc/tui/client.py:549`); per-agent counters surfaced on
      heartbeats too.
- [x] Collective compliance health bar — min over non-stale
      agents (30 s window); colour buckets at 90/70/50%.
- [x] Tests — 32 new cases across aggregator (17) + renderer (15);
      138/138 across the full suite.

**Status:** ✅ landed.

### PR #9 — Performance dashboard ✅

- [x] Per-skill / per-MCP `capability_stats` table — folded
      from `TASK_COMPLETE.invocations[]` into a `kind:target`
      keyed map (`src/performance/aggregator.ts`); ok-rate
      buckets at 95/80%; last_error column truncated.
- [x] Per-agent table — `queue_depth`, `backpressure_state`,
      `last_task_latency_ms`, `token_budget_utilization`,
      `drift_score` + a client-side 32-reading sparkline (the
      runtime publishes only point-in-time scalars; no time
      series wire shape exists today).
- [x] Cost-cap progress bar — `tokens_used` accumulated per
      `plan_id` (or `cluster_id`, then `'global'`) from
      `TASK_COMPLETE`; `max_run_tokens` captured from `PLAN`;
      crit/warn/ok colour buckets.
- [x] Latency percentiles header — p50/p90/p95/p99 over
      non-stale agents (30 s window).
- [x] Tests — 36 new cases across aggregator (19) +
      renderer (17); 174/174 across the full suite.

**Status:** ✅ landed.

### PR #10 — Optional Kaiden import ✅

- [x] Detect `kdn` workspace registry — `<workspace>/.kaiden/
      workspace.json` is the documented stable shape; we walk
      from `acc.repoPath` up six levels then fall back to cwd
      and home (`src/kaiden/discovery.ts`).  Operator override
      via `acc.kaidenWorkspacePath` setting.
- [x] Pasted-JSON fallback — covers the Kaiden GUI case (its
      on-disk format is undocumented).
- [x] "Import as ACC MCP manifest" — writes
      `mcps/<name>/mcp.yaml` with operator-supplied
      `risk_level` + `allowed_tools[]` + optional
      `manifestName` override (`src/kaiden/import.ts`).
      Pure-fn `buildMcpYaml` for testability.
- [x] One-way + secrets stripped — env-var values + HTTP-header
      values are NEVER carried over.  We surface only the
      *names* with a comment block instructing the operator to
      wire them into `deploy/.env` themselves.  Kaiden's loose
      "no per-tool gating, no risk classification" model never
      reverse-trusts ACC's manifests.
- [x] Optional surface — panel + command available always; the
      panel reports plainly when no workspace is detected and
      offers the paste path.
- [x] Tests — 25 new cases across discovery (12) +
      import / YAML build (13); 199/199 across the full suite.

**Status:** ✅ landed.  Closes v0.2.

## v0.3 — Distribution + polish (sketch)

Both v0.1 and v0.2 are closed.  v0.3 is a smaller maintenance
milestone focused on getting the extension into operator hands
rather than adding new surfaces.

### PR #11 — Publish flow

- [ ] Choose a distribution channel — Podman Desktop's
      extension catalogue, GitHub Releases, or both.  File the
      catalogue PR upstream once package metadata is camera-ready.
- [ ] `npm run package` script that produces a tarball / OCI
      image PD can install from a folder/URL.
- [ ] CI workflow — typecheck + test + package on every PR;
      release artefact on tag push.

### PR #12 — README + icon + screenshots

- [ ] Real `icon.png` (current is a placeholder).
- [ ] README with screenshot of every left-nav panel.
- [ ] Cross-link from runtime repo `INDEX_*.md` (deferred from
      PR #6).

### PR #13 — Settings hardening

- [ ] Validate `acc.repoPath` on save — surface a warning when
      `acc-deploy.sh` is missing.
- [ ] Validate `acc.natsUrl` shape; default-on connection test
      surfaced in the Stack panel header.
- [ ] Per-panel "panic stop" — disconnect NATS / kill spawned
      processes in one click.

### PR #14 — Prompt pane bridge (stretch)

- [ ] Mirror the runtime's TUI Prompt screen (TUI screen 7) as
      a webview that publishes TASK_ASSIGN with optional
      `target_agent_id` and renders the streaming TASK_COMPLETE
      back into the panel.
- [ ] Useful operator surface for ad-hoc dispatch without
      dropping into the TUI.

## Out of scope for this extension (forever)

* Authoring `role.md` from scratch in a built-in editor.  Defer
  to the user's editor.
* RAG pipeline builder — Kaiden owns that.
* Goose-style flow runtime — ACC's PLAN executor + iteration
  loop is the equivalent.
* Local model serving — AI Lab owns that.
* Container / Kubernetes management — Podman Desktop owns that.

## See also

* The strategic plan in the operator's Obsidian:
  `ACC Podman Desktop Plan.md`.
* The runtime repo:
  [agentic-cell-corpus](https://github.com/flg77/agentic-cell-corpus).
