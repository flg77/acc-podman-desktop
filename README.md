# ACC — Agentic Cell Corpus — Podman Desktop extension

> **Status: v0.0.1 scaffold.**  Loads as a PD extension; registers
> stack lifecycle + cluster topology + example runner commands.
> Real cluster topology rendering, NATS subscription, role/skill/MCP
> browser, and AI Lab cross-extension bridge land in the
> documented PR series ([`BACKLOG.md`](BACKLOG.md)).

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

## Install (development)

```bash
git clone https://github.com/flg77/acc-podman-desktop.git
cd acc-podman-desktop
pnpm install
pnpm build
```

In Podman Desktop → Settings → Extensions → "Add side-loaded
extension" → point at this directory.  PD reloads with the ACC
extension active.

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `acc.repoPath` | `""` (auto-detect) | Filesystem path to the agentic-cell-corpus repo. Auto-detect walks `~/`, `~/git/`, `~/src/`, `~/Downloads/git/agentic/`. |
| `acc.collectiveId` | `sol-01` | Default collective ID for cluster topology subscription + plan submission. |
| `acc.natsUrl` | `nats://localhost:4222` | NATS endpoint for the cluster topology panel. |

## Commands (v0.0.1)

| Command | Effect |
|---|---|
| `ACC: Bring stack up` | Runs `acc-deploy.sh up` in the configured repo. |
| `ACC: Stop stack` | Runs `acc-deploy.sh down`. |
| `ACC: Show stack status` | Runs `acc-deploy.sh status`. |
| `ACC: Show cluster topology` | Stub — coming in PR #2. |
| `ACC: Run coding-split example` | Runs `examples/coding_split_skills/run.sh`. |
| `ACC: Run autoresearcher example` | Runs `examples/acc_autoresearcher/run.sh --topic agentic-ai-strategy`. |

## Repository layout

```
acc-podman-desktop/
├── package.json                 — extension manifest + commands
├── tsconfig.json
├── src/
│   ├── extension.ts              — activate / deactivate
│   ├── core/paths.ts             — locate the operator's ACC install
│   ├── stack/commands.ts         — stack lifecycle
│   ├── cluster/topology.ts       — topology view (stub)
│   └── examples/registry.ts      — runnable example demos
├── tests/
│   └── paths.test.ts             — vitest smoke
├── BACKLOG.md                    — v0.1 + v0.2 PR plan
└── README.md                     — this file
```

## See also

* [agentic-cell-corpus](https://github.com/flg77/agentic-cell-corpus) — the runtime.
* [ai-lab-extension](https://github.com/containers/podman-desktop-extension-ai-lab) — the model-side companion.
* [Kaiden](https://github.com/openkaiden/kaiden) — the parallel single-developer agent workspace.

## License

[Apache 2.0](LICENSE)
