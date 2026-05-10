# OCI image for the ACC — Agentic Cell Corpus Podman Desktop extension.
#
# Base = UBI 10 minimal for ecosystem alignment with the rest of
# the ACC stack (every runtime container ships on UBI).  PD's
# "Install custom…" extracts /extension at install time; the
# runtime layer underneath is never executed by PD itself, so the
# choice of base is purely for ecosystem consistency + label
# carrying.  Trade-off: image jumps from ~10 MB (FROM scratch) to
# ~200 MB (UBI 10 minimal) — acceptable for ecosystem alignment.
#
# Per proposal 001 in the operator's Obsidian vault.
#
# Build locally:
#   npm run build
#   podman build -t acc-podman-desktop:dev .
#
# Install:
#   Podman Desktop → Settings → Extensions → Install custom…
#   → paste the image reference (`localhost/acc-podman-desktop:dev`
#     or `quay.io/flg77/acc-podman-desktop:<version>`).

FROM registry.access.redhat.com/ubi10/ubi-minimal:latest

LABEL org.opencontainers.image.title="ACC — Agentic Cell Corpus"
LABEL org.opencontainers.image.description="Manage governed multi-agent collectives from inside Podman Desktop. Stack provisioning, cluster topology, runnable example demos, role / skill / MCP browser, AI Lab auto-detect, compliance + performance dashboards, optional Kaiden import."
LABEL org.opencontainers.image.vendor="flg77"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.source="https://github.com/flg77/acc-podman-desktop"
LABEL org.opencontainers.image.url="https://quay.io/repository/flg77/acc-podman-desktop"
LABEL org.opencontainers.image.documentation="https://github.com/flg77/acc-podman-desktop/blob/main/docs/EXTENSION_implementation.md"
LABEL io.podman-desktop.api.version=">= 1.8.0"
LABEL quay.expires-after=""

COPY package.json /extension/
COPY icon.png    /extension/
COPY LICENSE     /extension/
COPY README.md   /extension/
COPY dist        /extension/dist
