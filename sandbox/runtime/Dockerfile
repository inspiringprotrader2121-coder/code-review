ARG BASE_IMAGE=node:22.23.1-bullseye-slim@sha256:e24976116684e0fd211cbdb3c40fc9cb997565d063fb7fe656d2e2b603c5bb0a
FROM ${BASE_IMAGE}

RUN npm install --global --ignore-scripts --no-audit --no-fund \
      pnpm@11.7.0 yarn@1.22.22 \
    && npm cache clean --force

WORKDIR /work
