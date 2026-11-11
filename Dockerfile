# ==========================================
# Production multi-stage Dockerfile for NereidAI
# All dependencies are installed and the frontend is built
# INSIDE the container. Nothing (node_modules/dist) is copied
# from the local checkout, so this works in CI (GitHub Actions)
# where those directories do not exist.
#
# Base images are overridable for air-gapped/mirrored build hosts.
# The defaults stay on Docker Hub names so GHCR Actions builds are
# unchanged; both defaults are official multi-arch (amd64/arm64) images.
# ==========================================
ARG NODE_IMAGE=node:24-alpine
ARG NGINX_IMAGE=nginx:alpine
# Rolling dev channel default; the release workflow injects bare SemVer
# (0.0.1) derived from the v-prefixed git tag, and the branch dev workflow
# injects 0.0.0-dev. No VERSION file exists in the repository.
ARG VERSION=0.0.0-dev

# ---- Frontend build stage ----
FROM ${NODE_IMAGE} AS frontend-build
ARG TARGETARCH
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
# Fix rollup missing native module on arm64 (npm optionalDependencies bug)
RUN if [ "$TARGETARCH" = "arm64" ]; then npm install @rollup/rollup-linux-arm64-musl --save=false; fi \
 && if [ "$TARGETARCH" = "amd64" ]; then npm install @rollup/rollup-linux-x64-musl --save=false; fi
RUN npx vite build

# ---- Backend Runtime (Express BFF) ----
FROM ${NODE_IMAGE} AS backend
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server/ ./server/
COPY docs/openapi-console.yaml ./docs/openapi-console.yaml
COPY docs/openapi-partner.yaml ./docs/openapi-partner.yaml
EXPOSE 3001
CMD ["node", "server/index.cjs"]

# ---- Frontend Runtime (Nginx + built dist) ----
FROM ${NGINX_IMAGE} AS frontend
WORKDIR /usr/share/nginx/html
COPY --from=frontend-build /app/dist ./
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Generate a self-signed TLS certificate if none is mounted, then start nginx.
# For production, mount real certificates at /etc/nginx/ssl instead.
RUN apk add --no-cache openssl && mkdir -p /etc/nginx/ssl
COPY docker/nginx-entrypoint.sh /usr/local/bin/nginx-entrypoint.sh
RUN chmod +x /usr/local/bin/nginx-entrypoint.sh
EXPOSE 80 443
ENTRYPOINT ["/usr/local/bin/nginx-entrypoint.sh"]
