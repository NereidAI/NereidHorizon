# Copyright (C) 2026 YIQISOFT
# SPDX-License-Identifier: Apache-2.0


REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
COMPOSE_FILE = docker-compose.yaml
COMPOSE_DEV_FILE = docker-compose.dev.yaml

# Centralized operator inputs live beside the repository, not in its working tree.
# All overrides may be absolute paths; defaults remain independent of the caller's cwd.
DEPLOY_VALUES_DIR ?= $(abspath $(REPO_ROOT)/../.deployment/deploy-values/nereidhorizon)
ENV_FILE ?= $(DEPLOY_VALUES_DIR)/backend.env
EXCHANGE_ENV_FILE ?= $(DEPLOY_VALUES_DIR)/exchange.env
VALUES_FILE ?= $(DEPLOY_VALUES_DIR)/values.yaml
LOG_DIR ?= $(abspath $(REPO_ROOT)/../.deployment/deploy-logs/nereidhorizon)
SESSION_KEY_FILE ?= $(DEPLOY_VALUES_DIR)/state/session.key
DEV_LOG_DIR ?= $(LOG_DIR)/dev
DEV_STATE_DIR ?= $(DEPLOY_VALUES_DIR)/state/dev
export DEPLOY_VALUES_DIR ENV_FILE EXCHANGE_ENV_FILE VALUES_FILE LOG_DIR SESSION_KEY_FILE DEV_LOG_DIR DEV_STATE_DIR

COMPOSE = docker compose --project-directory "$(REPO_ROOT)" --env-file "$(ENV_FILE)"

# Prefer docker; fall back to podman if docker is not in PATH.
DOCKER := $(shell command -v docker 2>/dev/null || command -v podman 2>/dev/null)

# Image publication coordinates (root treaty §18/§19). Local builds carry the
# three-tag scheme of §19.2 (VERSION, VERSION-<utc-timestamp>,
# VERSION-<git-short-sha>) and never push; GHCR publication belongs to the
# tag-triggered publish workflow.
REGISTRY ?= ghcr.io/nereidai
# No VERSION file: the git tag is the single version source (treaty §19). On
# an exact v* tag checkout use its bare SemVer (v0.0.1 -> 0.0.1); any other
# checkout builds the rolling dev channel 0.0.0-dev. CI may inject VERSION.
VERSION ?= $(shell ref=$$(git describe --tags --exact-match 2>/dev/null) && echo "$${ref#v}" || echo 0.0.0-dev)
GIT_SHA ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
BUILD_TS := $(shell date -u +%Y%m%d-%H%M)
BACKEND_IMAGE ?= $(REGISTRY)/nereidhorizon-backend
FRONTEND_IMAGE ?= $(REGISTRY)/nereidhorizon-frontend
# Local builds stay native/single-arch (treaty §19.2.1); the branch CI warms
# both release architectures through build-push-action instead.
PLATFORMS ?= linux/amd64,linux/arm64
comma := ,
LOCAL_PLATFORM = $(firstword $(subst $(comma), ,$(PLATFORMS)))

# Local dev PostgreSQL (used by dev-pg / dev-all). Dedicated to the BFF so it never
# collides with the Exchange or EdgeX databases. Listens on a non-default host port.
PG_CONTAINER = nereid-dev-pg
PG_IMAGE = postgres:16-alpine
PG_HOST_PORT = 5433
PG_CONTAINER_PORT = 5432
PG_DB = nereid
PG_USER = nereid
PG_PASS = nereidpass

# URL injected into $(ENV_FILE) so dev-backend connects out of the box without
# the caller having to set DATABASE_URL manually.
DATABASE_URL_DEV = postgres://$(PG_USER):$(PG_PASS)@127.0.0.1:$(PG_HOST_PORT)/$(PG_DB)

.PHONY: help install build dev-pg dev-backend dev-frontend dev-all dev-stop dev-clean docker-build docker-up docker-down docker-clean docker-logs docker-ps image image-backend image-frontend docker-dev-up docker-dev-build docker-dev-down docker-dev-clean docker-dev-logs docker-dev-ps clean lint test images-export images-load

# Default target
help:
	@echo "NereidHorizon - Available Commands:"
	@echo ""
	@echo "Local Development (npm):"
	@echo "  make install       - Install npm dependencies"
	@echo "  make build         - Build frontend for production (outputs to dist/)"
	@echo "  make dev-pg        - Start dedicated PostgreSQL for the BFF (idempotent), writes $(ENV_FILE)"
	@echo "  make dev-backend   - Start BFF backend in background, logs to $(LOG_DIR)/backend.log"
	@echo "  make dev-frontend  - Start Vite frontend dev server in background, logs to $(LOG_DIR)/frontend.log"
	@echo "  make dev-all       - (Re)start pg + backend + frontend (kills any existing dev servers first)"
	@echo "  make dev-stop      - Stop backend & frontend & pg (keeps pg data)"
	@echo "  make dev-clean     - Stop everything + remove build artifacts (dist) & dev database"
	@echo ""
	@echo "Docker (ghcr.io images - production):"
	@echo "  make docker-up     - Pull & start containers from GitHub Container Registry"
	@echo "  make docker-down   - Stop and remove containers (keeps data volumes)"
	@echo "  make docker-clean - Stop and remove containers AND data volumes"
	@echo "  make docker-logs   - Tail container logs"
	@echo "  make docker-ps     - Show production stack status"
	@echo "  make image         - Build backend+frontend locally with the three §19.2 tags (no push)"
	@echo ""
	@echo "Docker (local build - development/test, isolated project 'nereid-dev'):"
	@echo "  make docker-dev-build - Build Docker images from local source"
	@echo "  make docker-dev-up    - Build & start the local dev stack (isolated from prod)"
	@echo "  make docker-dev-down  - Stop local dev stack (keeps data volumes)"
	@echo "  make docker-dev-clean - Stop local dev stack AND remove data volumes"
	@echo "  make docker-dev-logs  - Tail local dev stack logs"
	@echo "  make docker-dev-ps    - Show local dev stack status"
	@echo ""
	@echo "Maintenance:"
	@echo "  make clean         - Remove dist/, node_modules/, and build artifacts"
	@echo "  make lint          - Run TypeScript type checking"
	@echo "  make test          - Run tests (if configured)"
	@echo ""
	@echo "Offline / Air-Gapped:"
	@echo "  make images-export - Build and export images to nereid-images.tar"
	@echo "  make images-load   - Load images from nereid-images.tar"

# ==========================================
# Local Development
# ==========================================
install:
	npm install

build:
	npm run build

dev-pg:
	@if [ -z "$(DOCKER)" ]; then echo "ERROR: neither docker nor podman found in PATH" >&2; exit 1; fi
	@if $(DOCKER) ps -a --format '{{.Names}}' | grep -qx '$(PG_CONTAINER)'; then \
		echo ">> $(PG_CONTAINER) exists, starting if stopped..."; \
		$(DOCKER) start $(PG_CONTAINER) >/dev/null 2>&1 || true; \
	else \
		echo ">> Creating $(PG_CONTAINER)..."; \
		$(DOCKER) run -d --name $(PG_CONTAINER) \
			-e POSTGRES_DB=$(PG_DB) \
			-e POSTGRES_USER=$(PG_USER) \
			-e POSTGRES_PASSWORD=$(PG_PASS) \
			-p 127.0.0.1:$(PG_HOST_PORT):$(PG_CONTAINER_PORT) \
			$(PG_IMAGE) >/dev/null; \
	fi
	@echo ">> Waiting for PostgreSQL on 127.0.0.1:$(PG_HOST_PORT)..."
	@for i in $$(seq 1 30); do \
		if $(DOCKER) exec $(PG_CONTAINER) pg_isready -U $(PG_USER) -d $(PG_DB) >/dev/null 2>&1; then break; fi; \
		sleep 1; \
	done
	@install -d -m 700 "$(dir $(ENV_FILE))"
	@if [ ! -f "$(ENV_FILE)" ]; then cp "$(REPO_ROOT)/.env.example" "$(ENV_FILE)"; fi
	@if grep -q '^DATABASE_URL=' "$(ENV_FILE)"; then \
		if sed --version 2>/dev/null | grep -q GNU; then \
			sed -i 's#^DATABASE_URL=.*#DATABASE_URL=$(DATABASE_URL_DEV)#' "$(ENV_FILE)"; \
		else \
			sed -i '' 's#^DATABASE_URL=.*#DATABASE_URL=$(DATABASE_URL_DEV)#' "$(ENV_FILE)"; \
		fi; \
	else \
		echo 'DATABASE_URL=$(DATABASE_URL_DEV)' >> "$(ENV_FILE)"; \
	fi
	@chmod 600 "$(ENV_FILE)"
	@echo ">> Started $(PG_CONTAINER), DATABASE_URL written to $(ENV_FILE)"

dev-backend:
	@echo ">> Stopping existing backend..."
	@pkill -f 'server/index\.cjs' 2>/dev/null || true
	@sleep 1
	@install -d -m 700 "$(LOG_DIR)" "$(dir $(SESSION_KEY_FILE))"
	@touch "$(LOG_DIR)/backend.log"
	@chmod 600 "$(LOG_DIR)/backend.log"
	@echo ">> Starting backend (background)..."
	@cd "$(REPO_ROOT)" && nohup npm run dev:backend >> "$(LOG_DIR)/backend.log" 2>&1 < /dev/null & \
	  echo "   backend pid $$!"
	@echo ">> Backend starting, logs: $(LOG_DIR)/backend.log"

dev-frontend:
	@echo ">> Stopping existing frontend..."
	@pkill -f 'node_modules/\.bin/vite' 2>/dev/null || true
	@sleep 1
	@install -d -m 700 "$(LOG_DIR)"
	@touch "$(LOG_DIR)/frontend.log"
	@chmod 600 "$(LOG_DIR)/frontend.log"
	@echo ">> Starting frontend (background)..."
	@cd "$(REPO_ROOT)" && nohup npm run dev >> "$(LOG_DIR)/frontend.log" 2>&1 < /dev/null & \
	  echo "   frontend pid $$!"
	@echo ">> Frontend starting, logs: $(LOG_DIR)/frontend.log"

# Start the whole local dev stack with one command: pg -> backend -> frontend.
# make runs prerequisites left-to-right, so dev-pg, dev-backend and dev-frontend
# all execute (each already runs in the background and returns immediately).
dev-all: dev-pg dev-backend dev-frontend
	@echo ">> Dev stack started: Frontend http://localhost:8080  Backend http://localhost:3001"

# Stop the whole local dev stack: backend, frontend, and the database container
# (pg data is preserved, so a later `make dev-all` reuses it without re-setup).
# Use narrow patterns so pkill cannot match make's own shell / the caller.
dev-stop:
	@echo ">> Stopping dev servers..."
	@pkill -f 'server/index\.cjs' 2>/dev/null || true
	@pkill -f 'node_modules/\.bin/vite' 2>/dev/null || true
	@if $(DOCKER) ps -a --format '{{.Names}}' | grep -qx '$(PG_CONTAINER)'; then \
		$(DOCKER) stop $(PG_CONTAINER) >/dev/null 2>&1; \
		echo ">> Stopped $(PG_CONTAINER)"; \
	else \
		echo ">> $(PG_CONTAINER) not found"; \
	fi
	@echo ">> Stopped backend, frontend, and $(PG_CONTAINER) (pg data preserved)"

# Fully clean the dev environment: stop servers, remove build artifacts (dist),
# and delete the dev database container + its data (a clean `dev-pg` rebuilds it).
dev-clean:
	@echo ">> Stopping dev servers..."
	@pkill -f 'server/index\.cjs' 2>/dev/null || true
	@pkill -f 'node_modules/\.bin/vite' 2>/dev/null || true
	@if $(DOCKER) ps -a --format '{{.Names}}' | grep -qx '$(PG_CONTAINER)'; then \
		$(DOCKER) rm -f $(PG_CONTAINER) >/dev/null 2>&1; \
	fi
	@echo ">> Removing build artifacts..."
	@rm -rf dist
	@echo ">> Removed $(PG_CONTAINER) ($(DATABASE_URL_DEV)) and dist/"

# ==========================================
# Docker (ghcr.io images — production)
# ==========================================
docker-up:
	$(COMPOSE) -f "$(REPO_ROOT)/$(COMPOSE_FILE)" up -d

docker-down:
	$(COMPOSE) -f "$(REPO_ROOT)/$(COMPOSE_FILE)" down

# Stop and remove containers AND their data volumes (postgres data lost).
docker-clean:
	$(COMPOSE) -f "$(REPO_ROOT)/$(COMPOSE_FILE)" down -v

docker-logs:
	$(COMPOSE) -f "$(REPO_ROOT)/$(COMPOSE_FILE)" logs -f

docker-ps:
	$(COMPOSE) -f "$(REPO_ROOT)/$(COMPOSE_FILE)" ps

# image builds both multi-stage production images for the local platform with
# the three tags of treaty §19.2 and loads them into the local daemon; nothing
# is pushed. The multi-arch index is built by the tag-triggered publish
# workflow, and the branch CI warms its buildx cache.
.PHONY: image image-backend image-frontend
image: image-backend image-frontend ## Build both production images locally (three tags, no push)

# No --load: a single-platform build lands in the local daemon by default, and
# the podman fallback in DOCKER has no buildx-style --load flag.
image-backend:
	$(DOCKER) build --target backend --platform $(LOCAL_PLATFORM) -f Dockerfile \
		-t $(BACKEND_IMAGE):$(VERSION) \
		-t $(BACKEND_IMAGE):$(VERSION)-$(BUILD_TS) \
		-t $(BACKEND_IMAGE):$(VERSION)-$(GIT_SHA) .

image-frontend:
	$(DOCKER) build --target frontend --platform $(LOCAL_PLATFORM) -f Dockerfile \
		-t $(FRONTEND_IMAGE):$(VERSION) \
		-t $(FRONTEND_IMAGE):$(VERSION)-$(BUILD_TS) \
		-t $(FRONTEND_IMAGE):$(VERSION)-$(GIT_SHA) .

# ==========================================
# Docker (local build — development/test).
#
# Runs a FULLY ISOLATED stack from production: it uses ONLY docker-compose.dev.yaml
# (which defines its own postgres/backend/frontend) under a DIFFERENT project
# name ("nereid-dev"). So `docker-dev-up` and `docker-up` can coexist without the
# dev containers colliding with the ghcr production containers.
# ==========================================
docker-dev-build:
	$(COMPOSE) -p nereid-dev -f "$(REPO_ROOT)/$(COMPOSE_DEV_FILE)" build

docker-dev-up:
	$(COMPOSE) -p nereid-dev -f "$(REPO_ROOT)/$(COMPOSE_DEV_FILE)" up -d --build

# Stop dev containers but keep dev data volumes (postgres data preserved).
docker-dev-down:
	$(COMPOSE) -p nereid-dev -f "$(REPO_ROOT)/$(COMPOSE_DEV_FILE)" down

# Stop dev containers AND remove dev data volumes.
docker-dev-clean:
	$(COMPOSE) -p nereid-dev -f "$(REPO_ROOT)/$(COMPOSE_DEV_FILE)" down -v

docker-dev-logs:
	$(COMPOSE) -p nereid-dev -f "$(REPO_ROOT)/$(COMPOSE_DEV_FILE)" logs -f

docker-dev-ps:
	$(COMPOSE) -p nereid-dev -f "$(REPO_ROOT)/$(COMPOSE_DEV_FILE)" ps

# Alias: build dev images (for testing local packaging)
docker-build: docker-dev-build

# ==========================================
# Maintenance
# ==========================================
clean:
	rm -rf dist node_modules package-lock.json

lint:
	npm run typecheck 2>/dev/null || npx tsc --noEmit

test:
	@echo "No test script configured. Add 'test' script to package.json to enable."

# ==========================================
# Offline / Air-Gapped image transfer
# ==========================================
images-export:
	./scripts/export-images.sh "$(VERSION)" nereid-images.tar

images-load:
	./scripts/load-images.sh nereid-images.tar