FROM node:20-bookworm-slim

LABEL org.opencontainers.image.title="AO Continuum Code Studio Portal"
LABEL org.opencontainers.image.description="Containerized Studio UI and local CodeIntent MCP bridge"

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --chown=node:node bridge.mjs server.mjs test.mjs ./
COPY --chown=node:node baseline.json studio_product.html ./

# Confirm that the five MCP tools can start and query the bundled baseline.
RUN node test.mjs

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "bridge.mjs"]
