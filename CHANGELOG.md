# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning per [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.3.1] — Unreleased — Quay.io migration + UBI 10 base

Per proposal 001 in the operator's Obsidian vault
(`AgenticCellCorpus/ACC Implementation/`).  Transitional release
that publishes to BOTH registries — `quay.io` becomes canonical;
`ghcr.io` stays live until v0.4.1.

### Changed

- **Canonical registry → quay.io.**  Released images now publish
  to `quay.io/flg77/acc-podman-desktop:<version>` first; GHCR
  mirror retained for the transition window (v0.3.x patches +
  v0.4.0).
- **Build host → acc1.**  Both `build-and-push` and
  `publish-release` run on the acc1 self-hosted GitHub runner
  (label `acc1`) — RHEL/UBI 10 throughout the workflow for
  ecosystem alignment.  Trade-off: acc1 outage blocks releases;
  operator re-tags when acc1 returns.
- **Base image → UBI 10 minimal.**  Containerfile switches from
  `FROM scratch` to
  `registry.access.redhat.com/ubi10/ubi-minimal:latest` for
  ecosystem alignment with the rest of the ACC stack.  Image
  size grows ~10 MB → ~200 MB; PD's `/extension` extraction
  path is unaffected.
- **Architecture pinned to amd64.**  arm64 deferred until acc1
  has a buildx cross-builder configured.

### Added

- `org.opencontainers.image.url` + `documentation` labels on the
  Containerfile.
- Required workflow secrets documented in `release.yml`:
  `QUAY_USERNAME`, `QUAY_PASSWORD`.

## [0.3.0] — 2026-05-09 — Distribution + polish

First installable release.  Closes the v0.3 milestone.

### Added

- **Publish flow** — `Containerfile` (`FROM scratch` with required
  PD labels), `npm run package` script, GitHub Actions release
  workflow that builds + pushes
  `ghcr.io/flg77/acc-podman-desktop:<version>` on `v*` tag push
  (PR #11).
- **Real icon** — 256×256 ACC mark (six sub-agent cells around an
  arbiter) replaces the 220-byte placeholder (PR #12).
- **Settings hardening** — `validateRepoPath()` +
  `validateNatsUrl()` validators run on every `acc.*` config
  change with a warning toast on failure; `acc.panicStop`
  command tears down every NATS-holding panel in one click (PR #13).
- **Prompt panel** — ad-hoc dispatch surface mirroring the TUI's
  screen 7; publishes `TASK_ASSIGN` with optional
  `target_agent_id`; renders streaming `TASK_PROGRESS` + final
  `TASK_COMPLETE` inline; Cmd/Ctrl+Enter shortcut (PR #14).

### Changed

- README rewritten — released-build install via GHCR + dev install
  via folder OR local OCI; v0.2 command table (PR #12).
- CI workflow fixed — was using pnpm with no lockfile; now `npm ci`
  + tsc + vitest + OCI build smoke (PR #11).
- Runtime-repo `INDEX_subagent_clustering.md` +
  `AUTORESEARCHER_index.md` cross-link to the extension (closes
  the deferral from v0.1 PR #6).

### Tests

- 235/235 passing across 20 test files; tsc clean.

## [0.2.0] — Cross-extension + governance dashboards

Closes the v0.2 milestone.

### Added

- **AI Lab Model Service auto-detect** — discovers running
  inference servers via the AI Lab REST API (`GET
  /api/v1/ps`), falls back to `podman ps` filtering on
  `ai-lab.model-id`; one-click "Wire to deploy/.env"
  (PR #7).
- **Compliance dashboard** — OWASP-LLM violation table (all 10
  codes), oversight queue with Approve/Reject (publishes
  `OVERSIGHT_DECISION`), per-agent Cat-A/B trigger summary,
  collective compliance health bar (PR #8).
- **Performance dashboard** — per-skill / per-MCP capability
  stats keyed `kind:target`, per-agent queue + backpressure +
  token utilisation + drift sparkline (client-side ring
  buffer), latency percentiles, per-plan cost-cap progress bars
  (PR #9).
- **Kaiden import** — one-way import of `kdn` `workspace.json`
  entries into ACC `mcp.yaml` manifests; secrets stripped
  (only names surfaced); operator-supplied risk_level +
  allowed_tools (PR #10).

### Tests

- 199/199 passing.

## [0.1.0] — Foundational extension surface

Closes the v0.1 milestone.

### Added

- Stack provisioning panel (PR #5) — lifecycle + profile toggles
  + `deploy/.env` editor + live container status.
- Manifest browser (PR #4) — Roles / Skills / MCPs tabs with
  risk pills + "Open in editor".
- Examples panel (PR #3) — coding-split + autoresearcher demos
  with live log + verification readout.
- Cluster topology panel (PR #2) — NATS-driven; 30 s grace
  window for finished clusters.
- Scaffold + commands + paths (PR #1).
- Documentation closer (PR #6) — module + wire-protocol
  reference + operator walkthrough.

### Tests

- 85/85 passing on close of v0.1.
