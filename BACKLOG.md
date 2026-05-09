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

### PR #2 — Cluster topology panel

- [ ] NATS subscription via `nats` npm package against
      `acc.{cid}.>`.
- [ ] Webview-rendered topology — Svelte panel mirroring the
      TUI prompt pane's cluster panel.
- [ ] Per-cluster row → expand to show members + skill_in_use +
      iteration_n (PR #41 fields).
- [ ] 30 s grace window for finished clusters (parity with TUI).
- [ ] Tests: subscription teardown, exception isolation per
      callback, schema-drift tolerance.

### PR #3 — Examples panel (proper UI)

- [ ] Replace command-only access with a left-nav panel that
      lists each example with Run / Verify / Clean buttons.
- [ ] Topic-slug input modal for the autoresearcher example.
- [ ] Live tail of plan re-broadcasts inside the panel.
- [ ] Surface `verify.sh` JSON output post-run.

### PR #4 — Role / Skill / MCP browser

- [ ] Three list views populated from the runtime repo's
      `roles/`, `skills/`, `mcps/`.
- [ ] Click a role → render `role.md` + eval rubric + estimator
      block.
- [ ] "Open role.md in editor" button (defers to system editor).
- [ ] Read-only — authoring stays in the operator's editor of
      choice.

### PR #5 — Stack provisioning panel (rich UI)

- [ ] Replace the command-line `acc.stack.*` actions with a
      first-class panel: live container status, profile toggles
      (TUI / coding-split / autoresearcher / mcp-echo), inline
      `deploy/.env` editor with the `env/use.sh` preset
      dropdown.
- [ ] One-click "rebuild" with the runtime repo's
      `acc-deploy.sh rebuild` flow.

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
