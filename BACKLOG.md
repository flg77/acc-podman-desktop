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

### PR #6 — Documentation closer

- [ ] `docs/EXTENSION_implementation.md` — wire-protocol +
      module reference.
- [ ] `docs/DEMO_PD_extension.md` — operator walkthrough.
- [ ] Update the runtime repo's `INDEX_*.md` to cross-link.

## v0.2 — Cross-extension + governance dashboards (~2-3 weeks)

### PR #7 — AI Lab Model Service auto-detect

- [ ] Discover running AI Lab Model Services via PD's
      extension-to-extension API (file upstream issue if not
      exposed today).
- [ ] One-click "Wire to deploy/.env as ACC_OPENAI_BASE_URL"
      action — the headline cross-extension story.
- [ ] Fall back to manual URL entry when AI Lab not running.

### PR #8 — Compliance dashboard

- [ ] OWASP violation log (mirrors TUI screen 3).
- [ ] Oversight queue with approve / reject buttons.
- [ ] Cat-A trigger summary chart per agent.

### PR #9 — Performance dashboard

- [ ] Per-skill / per-MCP `capability_stats` charts.
- [ ] Per-agent token utilisation + drift score over time.
- [ ] Cost-cap progress bar (PR #41 `tokens_used` /
      `max_run_tokens`).

### PR #10 — Optional Kaiden import

- [ ] Detect Kaiden's local MCP registry file under the user's
      profile dir.
- [ ] "Import as ACC MCP manifest" action that writes
      `mcps/<server_id>/mcp.yaml` with operator-supplied risk
      level + allow-list.
- [ ] One-way only — never reverse-trust Kaiden's loose model.
- [ ] Optional + not mandatory; v0.2 surfaces the option only
      when Kaiden's registry file is detectable.

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
