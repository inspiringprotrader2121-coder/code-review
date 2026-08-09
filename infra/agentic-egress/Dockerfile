ARG BASE_IMAGE=node:22.23.1-bullseye-slim@sha256:e24976116684e0fd211cbdb3c40fc9cb997565d063fb7fe656d2e2b603c5bb0a
FROM ${BASE_IMAGE}

WORKDIR /opt/orvex/agentic-egress
COPY broker.mjs ./broker.mjs

ENV NODE_ENV=production
EXPOSE 8080

# This endpoint intentionally exposes no configuration or credentials. It lets
# the provisioning flow prove that the broker consumed its short-lived mount.
HEALTHCHECK --interval=10s --timeout=2s --start-period=3s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:8080/healthz', r => process.exit(r.statusCode === 204 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["node", "/opt/orvex/agentic-egress/broker.mjs"]
