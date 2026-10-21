# Nexus Development Makefile
# Run `make help` for available commands.

.PHONY: help setup dev down logs api web worker-interactive worker-background local-runtime-identity \
	local-storage migrate migrate-down format format-back fix-front build build-android \
	build-android-release build-icons generate-resource-capabilities

-include .env
-include .dev-ports
export

SUPABASE_URL ?= http://127.0.0.1:54321

POSTGRES_PORT ?= 54320
LOCAL_S3_PORT ?= 8333
LOCAL_COMPOSE_PROJECT ?= nexus-local
LOCAL_RUNTIME_IDENTITY := $(abspath .nexus-local/runtime-identity.json)

DATABASE_URL ?= postgresql+psycopg://postgres:postgres@localhost:$(POSTGRES_PORT)/postgres
R2_S3_API_ORIGIN ?= http://127.0.0.1:$(LOCAL_S3_PORT)
R2_ACCESS_KEY_ID ?= nexus-local-access-key
R2_SECRET_ACCESS_KEY ?= nexus-local-secret-key
R2_BUCKET ?= media
R2_REGION ?= us-east-1

WEB_PORT ?= 3000
API_PORT ?= 8000
APP_PUBLIC_URL ?= http://localhost:$(WEB_PORT)
help:
	@echo "Nexus Development Commands"
	@echo ""
	@echo "Setup and run:"
	@echo "  make setup              - Install locked dependencies"
	@echo "  make dev                - Start persistent postgres, seaweedfs and supabase auth"
	@echo "  make down               - Stop local dev services"
	@echo "  make api                - Start FastAPI on API_PORT (default 8000)"
	@echo "  make web                - Start Next.js on WEB_PORT (default 3000)"
	@echo "  make worker-interactive - Start the interactive linux queue lane"
	@echo "  make worker-background  - Start the background linux queue lane"
	@echo ""
	@echo "Build:"
	@echo "  make build              - Build the web application"
	@echo "  make build-android      - Build the Android debug APK"
	@echo "  make build-android-release - Build signed Android release APK"
	@echo "  make build-icons        - Regenerate icons from apps/web/public/brand/asterism.svg"
	@echo "  make generate-resource-capabilities - Regenerate the browser resource-capability projection from the backend table"
	@echo ""
	@echo "Static checks:"
	@echo "  ./scripts/test          - Run formatting, lint, type, and migration graph checks"
	@echo ""
	@echo "Formatting:"
	@echo "  make format             - Apply backend formatting and frontend lint fixes"
	@echo "  make format-back        - Format backend Python"
	@echo "  make fix-front          - Apply frontend ESLint fixes"
	@echo ""
	@echo "Database:"
	@echo "  make migrate            - Run migrations on the dev database"
	@echo "  make migrate-down       - Roll back one dev migration"
	@echo ""
	@echo "Maintenance:"
	@echo "  make logs               - Show local compose service logs"

setup:
	uv sync --extra dev --extra codex-agent --locked --directory python
	bun install --frozen-lockfile --cwd apps/web
	bun install --frozen-lockfile --cwd node/ingest

dev:
	@echo "starting persistent local stores..."
	@COMPOSE_PROJECT_NAME=$(LOCAL_COMPOSE_PROJECT) docker compose -f docker/docker-compose.yml up -d --wait postgres storage
	@test "$$(supabase --version)" = "2.117.0" || { echo "supabase cli 2.117.0 is required" >&2; exit 1; }
	@mkdir -p .nexus-local
	@chmod 700 .nexus-local
	@echo "starting supabase auth on the application network..."
	@umask 077; supabase start --network-id $(LOCAL_COMPOSE_PROJECT)_default \
		-x realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,postgres-meta,postgrest \
		> .nexus-local/supabase-start.log 2>&1 || { echo "supabase start failed; inspect .nexus-local/supabase-start.log" >&2; exit 1; }
	@umask 077; supabase status --output json > .nexus-local/supabase-status.json
	@python/.venv/bin/python -c 'import json, os, pathlib; \
		status=json.loads(pathlib.Path(".nexus-local/supabase-status.json").read_text()); \
		url=status["API_URL"]; key=status["PUBLISHABLE_KEY"]; \
		values={name:os.environ[name] for name in ("POSTGRES_PORT", "DATABASE_URL", "WEB_PORT", "API_PORT", "LOCAL_S3_PORT", "R2_S3_API_ORIGIN", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_REGION")}; \
		values.update(SUPABASE_URL=url, SUPABASE_ANON_KEY=key, SUPABASE_JWKS_URL=url+"/auth/v1/.well-known/jwks.json", SUPABASE_ISSUER=url+"/auth/v1", SUPABASE_AUDIENCES="authenticated", NEXT_PUBLIC_SUPABASE_URL=url, NEXT_PUBLIC_SUPABASE_ANON_KEY=key); \
		pathlib.Path(".dev-ports").write_text("".join(name+"="+value+"\n" for name,value in values.items())); \
		pathlib.Path(".dev-ports").chmod(0o600); \
		pathlib.Path(".nexus-local/supabase-status.json").unlink()'
	@$(MAKE) local-storage
	@echo "persistent stores ready; auth and storage settings written to .dev-ports"

local-storage:
	PYTHONPATH=python python/.venv/bin/python python/scripts/local_storage.py \
		--origin http://localhost:$(WEB_PORT) --origin http://127.0.0.1:$(WEB_PORT) \
		--origin http://10.0.2.2:$(WEB_PORT)

down:
	@echo "Stopping local dev services..."
	@supabase stop
	@COMPOSE_PROJECT_NAME=$(LOCAL_COMPOSE_PROJECT) docker compose -f docker/docker-compose.yml down --remove-orphans
	@rm -f .dev-ports

logs:
	COMPOSE_PROJECT_NAME=$(LOCAL_COMPOSE_PROJECT) docker compose -f docker/docker-compose.yml logs -f

local-runtime-identity:
	@mkdir -p $(dir $(LOCAL_RUNTIME_IDENTITY))
	@temporary="$(LOCAL_RUNTIME_IDENTITY).partial"; \
		PYTHONPATH=python uv run --project python --frozen --no-sync python -m nexus.release_artifact \
			write-runtime-identity --repo-root . --source-sha "$$(git rev-parse HEAD)" --output "$$temporary" && \
		mv "$$temporary" "$(LOCAL_RUNTIME_IDENTITY)"

api: local-runtime-identity
	cd apps/api && PYTHONPATH=$$PWD/../../python DATABASE_URL=$(DATABASE_URL) \
		NEXUS_RUNTIME_IDENTITY_FILE=$(LOCAL_RUNTIME_IDENTITY) \
		SUPABASE_AUTH_ADMIN_KEY= \
		uv run --project ../../python uvicorn main:app --reload --port $(API_PORT)

web: local-storage
	cd apps/web && \
		VERCEL_GIT_COMMIT_SHA="$$(git -C ../.. rev-parse HEAD)" \
		FASTAPI_BASE_URL=http://localhost:$(API_PORT) \
		NEXUS_ENV=$${NEXUS_ENV:-local} \
		NEXT_PUBLIC_SUPABASE_URL=$${NEXT_PUBLIC_SUPABASE_URL:-$(SUPABASE_URL)} \
		NEXT_PUBLIC_SUPABASE_ANON_KEY=$${NEXT_PUBLIC_SUPABASE_ANON_KEY:-$(SUPABASE_ANON_KEY)} \
		APP_PUBLIC_URL=$${APP_PUBLIC_URL:-http://localhost:$(WEB_PORT)} \
		bun run dev --port $(WEB_PORT)

worker-interactive worker-background: local-runtime-identity
	NEXUS_LOCAL_SOURCE_SHA="$$(git rev-parse HEAD)" \
		NEXUS_LOCAL_RUNTIME_IDENTITY_FILE="$(LOCAL_RUNTIME_IDENTITY)" \
		COMPOSE_PROJECT_NAME=$(LOCAL_COMPOSE_PROJECT) \
		docker compose -f docker/docker-compose.yml -f docker/docker-compose.worker.yml \
		up --build --no-deps $@

migrate:
	cd migrations && DATABASE_URL=$(DATABASE_URL) \
		uv run --project ../python alembic upgrade head

migrate-down:
	cd migrations && DATABASE_URL=$(DATABASE_URL) \
		uv run --project ../python alembic downgrade -1

format:
	make format-back
	make fix-front

format-back:
	cd python && uv run ruff format .

fix-front:
	cd apps/web && bun run lint -- --fix

build:
	cd apps/web && bun run build

build-android:
	cd apps/android && ./gradlew :app:assembleDebug

build-android-release:
	cd apps/android && ./gradlew :app:lintRelease :app:assembleRelease

build-icons:
	node scripts/build-icons.mjs

generate-resource-capabilities:
	cd python && uv run python scripts/generate_resource_capabilities.py
