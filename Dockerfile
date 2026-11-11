# Copyright (C) 2026 YIQISOFT
# SPDX-License-Identifier: Apache-2.0


# ==========================================
# Production multi-stage Dockerfile for NereidHorizon
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
# Image traceability metadata; callers (publish workflows / Makefile) inject
# the real values. ARG scope is per-stage, so each final stage re-declares them.
ARG GIT_SHA=unknown
ARG BUILD_DATE=""

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
# Re-declare build args: global ARGs are not visible inside a stage without this.
ARG VERSION
ARG GIT_SHA
ARG BUILD_DATE
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server/ ./server/
COPY docs/openapi-console.yaml ./docs/openapi-console.yaml
COPY docs/openapi-partner.yaml ./docs/openapi-partner.yaml
# Ship the license and copyright notices inside the image (scanner-friendly /licenses path).
COPY LICENSE NOTICE /licenses/
LABEL license='SPDX-License-Identifier: Apache-2.0' \
      copyright='Copyright (c) 2026: YIQISOFT' \
      org.opencontainers.image.title='nereidhorizon-backend' \
      org.opencontainers.image.description='Edge distribution console - Open Horizon Exchange UI with BFF proxy and React console for policy-driven rollout and OTA lifecycle at fleet scale' \
      org.opencontainers.image.vendor='YIQISOFT' \
      org.opencontainers.image.licenses='Apache-2.0' \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source='https://github.com/NereidAI/NereidHorizon' \
      org.opencontainers.image.url='https://github.com/NereidAI/NereidHorizon' \
      org.opencontainers.image.documentation='https://github.com/NereidAI/NereidHorizon#readme' \
      org.opencontainers.image.authors='NereidAI (https://github.com/NereidAI)'
EXPOSE 3001
CMD ["node", "server/index.cjs"]

# ---- Frontend Runtime (Nginx + built dist) ----
FROM ${NGINX_IMAGE} AS frontend
# Re-declare build args: global ARGs are not visible inside a stage without this.
ARG VERSION
ARG GIT_SHA
ARG BUILD_DATE
WORKDIR /usr/share/nginx/html
COPY --from=frontend-build /app/dist ./
# Ship the license and copyright notices inside the image (scanner-friendly /licenses path).
COPY LICENSE NOTICE /licenses/
LABEL license='SPDX-License-Identifier: Apache-2.0' \
      copyright='Copyright (c) 2026: YIQISOFT' \
      org.opencontainers.image.title='nereidhorizon-frontend' \
      org.opencontainers.image.description='Edge distribution console - Open Horizon Exchange UI with BFF proxy and React console for policy-driven rollout and OTA lifecycle at fleet scale' \
      org.opencontainers.image.vendor='YIQISOFT' \
      org.opencontainers.image.licenses='Apache-2.0' \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source='https://github.com/NereidAI/NereidHorizon' \
      org.opencontainers.image.url='https://github.com/NereidAI/NereidHorizon' \
      org.opencontainers.image.documentation='https://github.com/NereidAI/NereidHorizon#readme' \
      org.opencontainers.image.authors='NereidAI (https://github.com/NereidAI)'
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Generate a self-signed TLS certificate if none is mounted, then start nginx.
# For production, mount real certificates at /etc/nginx/ssl instead.
RUN apk add --no-cache openssl && mkdir -p /etc/nginx/ssl
COPY docker/nginx-entrypoint.sh /usr/local/bin/nginx-entrypoint.sh
RUN chmod +x /usr/local/bin/nginx-entrypoint.sh
EXPOSE 80 443
ENTRYPOINT ["/usr/local/bin/nginx-entrypoint.sh"]
