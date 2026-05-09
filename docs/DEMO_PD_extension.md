# DEMO — ACC Podman Desktop extension (v0.1)

Operator walkthrough of the six left-nav panels the v0.1 extension
installs into Podman Desktop.  Mirrors the runtime repo's
`docs/DEMO_TUI_subagent_clustering.md` / `docs/DEMO_TUI_autoresearcher.md`
shape: phase-by-phase, with what the operator clicks, what the panel
should render, and the anti-checks for "this looks wrong" moments.

This is the public face of the BYOA story — the same governance the
TUI exposes, made click-driven for operators who live in Podman
Desktop.

---

## Prerequisites

* Podman Desktop ≥ 1.8.
* A working clone of `agentic-cell-corpus` somewhere on disk.  The
  extension finds it by (1) `acc.installRoot` config setting, (2)
  walking up from `$HOME` for a directory containing
  `acc-deploy.sh` + `deploy/podman-compose.yml`, or (3) `acc-deploy.sh`
  on `$PATH`.
* `podman` on `$PATH` (PD installs it for you on macOS / Windows).
* Optional but recommended: a model preset under `env/` — pick one
  with `env/use.sh <preset>` from the CLI before launching PD, or use
  the inline preset selector inside the Stack panel (PR #5).

## Install (dev)

```bash
git clone https://github.com/flg77/acc-podman-desktop
cd acc-podman-desktop
npm install
npm run build
# Point Podman Desktop at the dist/ folder via Settings → Extensions →
# Install from folder.  Reload PD; the six commands below appear in
# the command palette and the left nav.
```

The published-extension flow is on the v0.2 backlog.

---

## Phase 0 — Find your install

| Where | What |
|---|---|
| Command palette → `ACC: Stack — Show panel` | Opens the **Stack** panel (PR #5).  The panel header shows the resolved install root.  If it says "ACC install not found," set `acc.installRoot` in PD settings and reload. |

If install resolution fails, every command short-circuits with a
toast pointing at the settings key.  No silent half-states.

---

## Phase 1 — Bring the stack up

Open **Stack** (left nav, PR #5).

1. **Profiles** — toggle `TUI`, `MCP_ECHO`, `AUTORESEARCHER`,
   `CODING_SPLIT`, `DETACH` checkboxes.  Click "Save profiles" — the
   panel patches `deploy/.env` conservatively (preserves comments and
   unrelated lines).
2. **Preset** — pick a model preset from the dropdown (mirrors
   `env/use.sh`); the panel backs up `deploy/.env` to `.env.bak`
   before overwriting.
3. **Inline editor** — for ad-hoc edits the textarea below is a
   straight read/write of `deploy/.env`.
4. **Up** — click; the log pane streams stdout/stderr from
   `acc-deploy.sh up`.  Stop is cooperative SIGTERM (escalates to
   SIGKILL after 2 s if the process ignores it).

The container table refreshes every 5 s via `podman ps --format json`
filtered to `acc-*`.  When healthy you should see (depending on
profiles):

* `acc-redis`, `acc-nats` — always.
* `acc-agent-arbiter`, `acc-agent-coding-{1,2,3}` — coding cluster.
* `acc-mcp-echo`, `acc-mcp-web-{search-brave,fetch,browser-harness}`
  — MCP servers when the matching profile is on.
* `acc-tui` — when `TUI=true`.

**Anti-check:** if the container table stays empty for >10 s after
"Up" exits, podman is reachable but no containers match `acc-*` —
re-check the profiles + that the `acc-deploy.sh up` log pane finished
without errors.

---

## Phase 2 — Watch the cluster topology

Open **Cluster topology** (left nav, PR #2).

* The panel subscribes to `acc.{cid}.>` via the `nats` npm package.
* Each cluster_id renders as a row: members, current `skill_in_use`
  (parsed from "Calling skill:<name>" / "Calling mcp:<server>.<tool>"
  step labels), iteration_n.
* Finished clusters linger 30 s before disappearing — operator parity
  with the TUI's grace window.

Send a smoke task from the TUI or `acc-cli plan submit ...` and you
should see:

```
sol-01
 ├─ coding_split (3 members)   skill:code_review     iter=1
 └─ autoresearcher (6 members) mcp:web_fetch.fetch  iter=2
```

**Anti-check:** if the panel shows "No active clusters" while you
know an arbiter is dispatching, the NATS subject is wrong —
double-check `ACC_COLLECTIVE_ID` in `deploy/.env` matches the
collective id you're publishing under.

---

## Phase 3 — Run the demos

Open **Examples** (left nav, PR #3).

Two cards:

### Coding-split

1. Click **Run** — the runner spawns `examples/coding_split/run.sh`
   (Windows: WSL bash invocation via shell mode).
2. Stdout/stderr stream into the panel log.
3. Click **Verify** — runs `verify.sh`; the post-run reads
   `runs/<topic>-<date>/.verification.json` and the panel renders a
   coloured headline + bullet details card (green ✅ / red ❌).
4. **Stop** is per-card: cooperative SIGTERM → SIGKILL after 2 s.

### Autoresearcher

1. Type a topic slug in the inline `<input>` (e.g.
   `quantum-computing-trends`).  Slug is passed as `--topic <slug>`.
2. **Run** spawns `examples/autoresearcher/run.sh`.
3. **Verify** parses `runs/<topic>-<date>/.verification.json` (six
   pass/fail rows: structure, citation_count, paywall_recognized,
   etc.).
4. **Clean** removes the `runs/<topic>-*` tree.

**Anti-check:** if Run says "ACC install not found," the path
resolver couldn't locate `examples/<name>/run.sh` under the install
root.  Check the path under Stack panel header.

---

## Phase 4 — Browse roles / skills / MCPs

Open **Manifest browser** (left nav, PR #4).

Three tabs (Roles / Skills / MCPs) with live counters.  Loaded from
`roles/`, `skills/`, `mcps/` under the install root via the `yaml`
package.

* **Click a row** → right pane renders the manifest's summary
  (persona, domain, max_parallel_tasks, default_skills,
  allowed_skills, max_skill_risk_level, default_mcps, allowed_mcps,
  max_mcp_risk_level, estimator strategy for roles; risk pill +
  domain + tags for skills; transport + risk + allowed_tools for
  MCPs).
* **Per-file "Open in editor"** buttons spawn `$EDITOR` first, then
  fall back to platform defaults (`open` on macOS, `start ""` on
  Windows, `xdg-open` on Linux).  The extension stays read-only;
  authoring lives in the operator's editor.

Risk pills are coloured per LOW/MEDIUM/HIGH/CRITICAL — same
colour palette the TUI Compliance panel uses.

**Anti-check:** unparseable manifests are skipped silently (count
just goes down by one).  If a role you authored doesn't show up, run
`acc-cli role lint roles/<name>/role.md` from the CLI to see the
parse error.

---

## Phase 5 — Tear down

Back to **Stack** panel.  Click **Down** — streams
`acc-deploy.sh down` into the log pane.  Container table empties
within ~5 s.

Optional: `clean.sh` from the Examples panel removes per-run scratch
dirs (`runs/<topic>-*`).

---

## What v0.1 deliberately does NOT do

* No first-class **Compliance** dashboard (oversight queue,
  Cat-A/B/C violations) — slated for v0.2 PR #8.
* No **Performance** dashboard (per-skill / per-MCP capability_stats,
  drift, cost cap) — v0.2 PR #9.
* No **AI Lab Model Service** auto-detect — v0.2 PR #7.
* No **Kaiden import** — v0.2 PR #10 (optional, one-way only).
* No authoring UI for `role.md` / `skill.yaml` / `mcp.yaml` — defer
  to operator's editor, forever.
* No RAG pipeline builder (Kaiden owns), no Goose-style flow
  authoring (PLAN executor is the equivalent), no model serving (AI
  Lab owns), no container management (PD itself owns).

See `BACKLOG.md` for the v0.2 plan.

---

## Cross-references

* `docs/EXTENSION_implementation.md` — module + wire-protocol
  reference for everything in this walkthrough.
* Runtime repo: `docs/DEMO_TUI_subagent_clustering.md`,
  `docs/DEMO_TUI_autoresearcher.md` — TUI parity walkthroughs the
  extension panels mirror.
* Runtime repo: `docs/AUTORESEARCHER_implementation.md` for what the
  autoresearcher example exercises end-to-end.

---

## Troubleshooting matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| "ACC install not found" toast on every command | Path resolver miss | Set `acc.installRoot` in PD settings; reload extension. |
| Stack panel container table stays empty after Up | Profile mismatch / podman not on `$PATH` | Verify `podman ps` works from host shell; re-check profile checkboxes. |
| Cluster topology empty during a known run | Wrong collective id | Confirm `ACC_COLLECTIVE_ID` in `deploy/.env` matches the publishing arbiter. |
| Examples panel "Verify" says "no .verification.json" | run.sh exited before writing the report | Scroll the log pane for the upstream error; common: missing API key. |
| Manifest browser missing a role you authored | YAML parse error | `acc-cli role lint roles/<name>/role.md` — fix the YAML, the panel auto-refreshes on the next reload. |
| "Open in editor" opens nothing | `$EDITOR` unset + no platform default | Set `$EDITOR` (e.g. `code -w`) and reload PD. |
| Stop button doesn't kill an example | Process trapped SIGTERM | Wait 2 s — runner escalates to SIGKILL automatically. |
