ARG BASE_IMAGE=node:22.23.1-bullseye-slim@sha256:e24976116684e0fd211cbdb3c40fc9cb997565d063fb7fe656d2e2b603c5bb0a
FROM ${BASE_IMAGE}

ARG CODEX_VERSION=0.147.0
LABEL orvex.codex-version="${CODEX_VERSION}"
RUN corepack enable \
    && corepack prepare pnpm@11.7.0 --activate \
    && corepack prepare yarn@1.22.22 --activate \
    && npm install --prefix /opt/orvex --no-audit --no-fund --ignore-scripts "@openai/codex@${CODEX_VERSION}" \
    && test -r /opt/orvex/node_modules/@openai/codex/bin/codex.js

WORKDIR /work
