# ACC — Agentic Cell Corpus — Podman Desktop extension

> **Status: v0.2 closed.**  Eight left-nav panels (Stack, Cluster
> Topology, Examples, Manifest Browser, AI Lab auto-detect,
> Compliance, Performance, Kaiden import).  199 tests passing.
> v0.3 is a maintenance milestone (publish flow, README polish,
> settings hardening) — see [`BACKLOG.md`](BACKLOG.md).

Manage governed multi-agent collectives from inside Podman
Desktop.  Sibling extension to
[Podman AI Lab](https://github.com/containers/podman-desktop-extension-ai-lab):
AI Lab gets a model running locally; this extension runs a
Cat-A/B/C-governed agent fleet that calls it.

## Why

ACC's governance + multi-agent clustering is currently driven from
a Textual TUI + `acc-cli`.  Operators using Podman Desktop already
have AI Lab in the same drawer.  This extension closes the loop —
a developer can:

1. Start a local Llama via AI Lab.
2. Bring up the ACC stack with one click.
3. Run a research demo from the Examples panel.
4. Watch the cluster topology live in PD.

…without leaving Podman Desktop.

For the strategic + design rationale, read the planning brief in
the operator's Obsidian repo — `ACC Podman Desktop Plan.md`.

## What this extension does NOT do

* **Run the ACC runtime itself.**  This extension is a UI shim
  over the operator's existing
  [agentic-cell-corpus](https://github.com/flg77/agentic-cell-corpus)
  install.  Set `acc.repoPath` in PD settings to the ACC repo
  root, or place `acc-deploy.sh` on `PATH`.
* **Replace the TUI.**  Remote / SSH operators continue to use
  `acc-tui`.  Both surfaces consume the same NATS streams.
* **Re-implement Podman Desktop's container management.**  PD owns
  that fully.
* **Compete with Kaiden.**  Kaiden serves single-developer chat +
  Goose flows; ACC serves governed multi-agent fleets.  Both are
  open source; the v0.2 Kaiden import path is a one-way
  *complementary* migration helper — see the planning doc § 8.1.

## Install — released build

Once a `v0.x.y` tag has been pushed, the release workflow publishes
an OCI image to GHCR.  Install via:

1. **Podman Desktop → Settings → Extensions → "Install custom…"**
2. Paste `ghcr.io/flg77/acc-podman-desktop:latest` (or pin a
   specific tag).
3. PD pulls the image and activates the extension.

## Install — development

```bash
git clone https://github.com/flg77/acc-podman-desktop.git
cd acc-podman-desktop
npm install
npm run build
# Option A — folder install:
#   PD → Settings → Extensions → Install custom… → point at this dir.
# Option B — local OCI image (matches the released flow):
npm run package          # uses podman; or `npm run package:docker`
#   then PD → Install custom… → `localhost/acc-podman-desktop:dev`
```

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `acc.repoPath` | `""` (auto-detect) | Filesystem path to the agentic-cell-corpus repo. Auto-detect walks `~/`, `~/git/`, `~/src/`, `~/Downloads/git/agentic/`. |
| `acc.collectiveId` | `sol-01` | Default collective ID for cluster topology subscription + plan submission. |
| `acc.natsUrl` | `nats://localhost:4222` | NATS endpoint for the cluster topology panel. |

## Commands (v0.2)

| Command | Panel |
|---|---|
| `ACC: Open stack panel` | Stack lifecycle + profile toggles + `deploy/.env` editor + live container status. |
| `ACC: Show cluster topology` | Live NATS-driven cluster topology with 30 s grace window. |
| `ACC: Open examples panel` | Coding-split + autoresearcher demos with live log + verification readout. |
| `ACC: Browse roles, skills + MCPs` | Read-only manifest browser with risk pills + "Open in editor". |
| `ACC: Detect AI Lab Model Services` | One-click "Wire to deploy/.env as ACC_OPENAI_BASE_URL" — the cross-extension story. |
| `ACC: Open compliance dashboard` | OWASP-LLM table, oversight queue (Approve/Reject), Cat-A/B per-agent triggers. |
| `ACC: Open performance dashboard` | Per-skill / per-MCP capability stats, drift sparkline, cost-cap progress. |
| `ACC: Import MCP servers from Kaiden` | One-way import of `kdn` workspace.json with operator-supplied risk + allow-list. |

## Repository layout (v0.2)

```
acc-podman-desktop/
├── package.json                 — extension manifest + commands + scripts
├── Containerfile                — OCI image build (FROM scratch + labels)
├── src/
│   ├── extension.ts              — activate / deactivate
│   ├── core/                     — paths + logger
│   ├── stack/                    — lifecycle + env-file + status panel
│   ├── cluster/                  — NATS subscriber + aggregator + renderer
│   ├── examples/                 — runner + verification + panel
│   ├── manifests/                — role / skill / MCP loader + browser
│   ├── ailab/                    — REST + podman-ps discovery + wire-env
│   ├── compliance/               — OWASP / oversight / Cat-A aggregator + panel
│   ├── performance/              — capability_stats + drift + cost-cap
│   └── kaiden/                   — kdn workspace import (one-way)
├── tests/                       — vitest, 199 cases
├── docs/
│   ├── EXTENSION_implementation.md — module + wire-protocol reference
│   └── DEMO_PD_extension.md       — operator walkthrough
├── BACKLOG.md                    — PR plan (v0.1 ✅ · v0.2 ✅ · v0.3 sketch)
└── README.md                     — this file
```

## See also

* [agentic-cell-corpus](https://github.com/flg77/agentic-cell-corpus) — the runtime.
* [ai-lab-extension](https://github.com/containers/podman-desktop-extension-ai-lab) — the model-side companion.
* [Kaiden](https://github.com/openkaiden/kaiden) — the parallel single-developer agent workspace.

## License

[Apache 2.0](LICENSE)
