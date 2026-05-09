# OCI image for the ACC — Agentic Cell Corpus Podman Desktop extension.
#
# Per https://podman-desktop.io/docs/extensions/publish PD extensions
# are scratch images carrying the built JS + manifest + icon at
# /extension; PD extracts them at install time.  No runtime / no
# entrypoint is needed — the JS is loaded via PD's extension host.
#
# Build locally:
#   npm run build
#   podman build -t acc-podman-desktop:dev .
#
# Install:
#   Podman Desktop → Settings → Extensions → Install custom…
#   → paste the image reference (`localhost/acc-podman-desktop:dev`
#     or `ghcr.io/flg77/acc-podman-desktop:<version>`).

FROM scratch

LABEL org.opencontainers.image.title="ACC — Agentic Cell Corpus"
LABEL org.opencontainers.image.description="Manage governed multi-agent collectives from inside Podman Desktop. Stack provisioning, cluster topology, runnable example demos, role / skill / MCP browser, AI Lab auto-detect, compliance + performance dashboards, optional Kaiden import."
LABEL org.opencontainers.image.vendor="flg77"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.source="https://github.com/flg77/acc-podman-desktop"
LABEL io.podman-desktop.api.version=">= 1.8.0"

COPY package.json /extension/
COPY icon.png /extension/
COPY LICENSE /extension/
COPY README.md /extension/
COPY dist /extension/dist
