ARG BASE_IMAGE=node:22.23.1-bullseye-slim@sha256:e24976116684e0fd211cbdb3c40fc9cb997565d063fb7fe656d2e2b603c5bb0a
FROM ${BASE_IMAGE}

RUN corepack enable \
    && corepack prepare pnpm@11.7.0 --activate \
    && corepack prepare yarn@1.22.22 --activate

WORKDIR /work
