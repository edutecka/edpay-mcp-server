FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /app
COPY mcp-server/package*.json ./mcp-server/
RUN npm ci --prefix ./mcp-server --no-audit --no-fund
COPY mcp-server/tsconfig.json ./mcp-server/
COPY mcp-server/src ./mcp-server/src
COPY openapi ./openapi
RUN npm run build --prefix ./mcp-server \
    && npm prune --prefix ./mcp-server --omit=dev --no-audit --no-fund

FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime
RUN addgroup -S -g 10001 edpay \
    && adduser -S -D -H -u 10001 -G edpay edpay \
    && mkdir -p /app/mcp-server /app/openapi \
    && chown -R edpay:edpay /app
COPY --from=build --chown=10001:10001 /app/mcp-server/package.json /app/mcp-server/package.json
COPY --from=build --chown=10001:10001 /app/mcp-server/node_modules /app/mcp-server/node_modules
COPY --from=build --chown=10001:10001 /app/mcp-server/dist /app/mcp-server/dist
COPY --from=build --chown=10001:10001 /app/openapi /app/openapi
ENV EDPAY_MCP_PORT=23883 \
    EDPAY_MCP_BIND_HOST=0.0.0.0 \
    EDPAY_MCP_ALLOWED_HOSTS=api-pay.edutecka.com \
    EDPAY_MCP_ALLOWED_ORIGINS=https://api-pay.edutecka.com
USER 10001:10001
EXPOSE 23883
CMD ["node", "/app/mcp-server/dist/http.js"]
