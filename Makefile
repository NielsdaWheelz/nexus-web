# Nexus Development Makefile
# Run `make help` for available commands.

.PHONY: help setup dev down logs clean api web worker-interactive worker-background \
	migrate migrate-down seed format format-back fix-front build build-android \
	build-android-release build-icons generate-resource-capabilities \
	smoke smoke-auth-redirects

-include .env
-include .dev-ports
export

override SERVICE_ROLE_KEY :=
override SUPABASE_DATABASE_URL :=
override SUPABASE_SERVICE_KEY :=
override SUPABASE_SERVICE_ROLE_KEY :=

SUPABASE_DB_PORT ?= 54322
SUPABASE_URL ?= http://127.0.0.1:54321
AUTH_ALLOWED_REDIRECT_ORIGINS ?= http://localhost:3000,http://127.0.0.1:3000,http://10.0.2.2:3000,http://localhost:3001,http://127.0.0.1:3001
STREAM_BASE_URL ?= http://localhost:$(API_PORT)
STREAM_CORS_ORIGINS ?= http://localhost:$(WEB_PORT),http://localhost:3000,http://localhost:3001

POSTGRES_PORT ?= 54320
MINIO_PORT ?= 9000
LOCAL_COMPOSE_PROJECT ?= nexus-local

DATABASE_URL ?= postgresql+psycopg://postgres:postgres@localhost:$(POSTGRES_PORT)/postgres
R2_S3_API_ORIGIN ?= http://127.0.0.1:$(MINIO_PORT)
R2_ACCESS_KEY_ID ?= nexus-local-access-key
R2_SECRET_ACCESS_KEY ?= nexus-local-secret-key
R2_BUCKET ?= media
R2_REGION ?= us-east-1

WEB_PORT ?= 3000
API_PORT ?= 8000
help:
	@echo "Nexus Development Commands"
	@echo ""
	@echo "Setup and run:"
	@echo "  make setup              - Install deps, start local services, run migrations"
	@echo "  make dev                - Start local Postgres, MinIO, and Supabase Auth"
	@echo "  make down               - Stop local dev services"
	@echo "  make api                - Start FastAPI on API_PORT (default 8000)"
	@echo "  make web                - Start Next.js on WEB_PORT (default 3000)"
	@echo "  make worker-interactive - Start the interactive Postgres queue lane"
	@echo "  make worker-background  - Start the background Postgres queue lane"
	@echo ""
	@echo "Build:"
	@echo "  make build              - Build the web application"
	@echo "  make build-android      - Build Android debug and instrumentation APKs"
	@echo "  make build-android-release - Build signed Android release APK"
	@echo "  make build-icons        - Regenerate icons from apps/web/public/brand/asterism.svg"
	@echo "  make generate-resource-capabilities - Regenerate the browser resource-capability projection from the backend table"
	@echo ""
	@echo "Testing:"
	@echo "  ./scripts/test --help   - List the sole test and verification API"
	@echo "  make smoke              - Post-deploy auth smoke check against production URLs"
	@echo "  make smoke-auth-redirects - Auth redirect/provider smoke and Supabase allowlist verification"
	@echo ""
	@echo "Formatting:"
	@echo "  make format             - Apply backend formatting and frontend lint fixes"
	@echo "  make format-back        - Format backend Python"
	@echo "  make fix-front          - Apply frontend ESLint fixes"
	@echo ""
	@echo "Database:"
	@echo "  make migrate            - Run migrations on the dev database"
	@echo "  make migrate-down       - Roll back one dev migration"
	@echo "  make seed               - Seed development data"
	@echo ""
	@echo "Maintenance:"
	@echo "  make logs               - Show local compose service logs"
	@echo "  make clean              - Clean generated files"

setup:
	./scripts/agency_setup.sh

dev:
	@echo "Starting local app data services..."
	@COMPOSE_PROJECT_NAME=$(LOCAL_COMPOSE_PROJECT) docker compose -f docker/docker-compose.yml up -d postgres minio minio-init
	@postgres_container=$$(COMPOSE_PROJECT_NAME=$(LOCAL_COMPOSE_PROJECT) docker compose -f docker/docker-compose.yml ps -q postgres); \
		for i in $$(seq 1 30); do \
			if docker exec "$$postgres_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi; \
			if [ "$$i" = "30" ]; then echo "Error: Postgres did not become ready in time" >&2; exit 1; fi; \
			sleep 1; \
		done
	@for i in $$(seq 1 30); do \
		if curl -fsS "http://127.0.0.1:$(MINIO_PORT)/minio/health/ready" >/dev/null 2>&1; then break; fi; \
		if [ "$$i" = "30" ]; then echo "Error: MinIO did not become ready in time" >&2; exit 1; fi; \
		sleep 1; \
	done
	@minio_init_container=$$(COMPOSE_PROJECT_NAME=$(LOCAL_COMPOSE_PROJECT) docker compose -f docker/docker-compose.yml ps -a -q minio-init); \
		if [ -z "$$minio_init_container" ]; then \
			echo "Error: MinIO bucket init container was not created" >&2; exit 1; \
		fi; \
		minio_init_exit=$$(docker wait "$$minio_init_container" 2>/dev/null || docker inspect -f '{{.State.ExitCode}}' "$$minio_init_container"); \
		if [ "$$minio_init_exit" != "0" ]; then \
			COMPOSE_PROJECT_NAME=$(LOCAL_COMPOSE_PROJECT) docker compose -f docker/docker-compose.yml logs minio-init >&2; \
			echo "Error: MinIO bucket init failed" >&2; exit 1; \
		fi
	@echo "Starting Supabase local Auth..."
	@supabase start -x realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,postgres-meta,postgrest
	@supabase_status=$$(supabase status --output json 2>&1 | grep -v '^Stopped services:'); \
		supabase_url=$$(printf '%s\n' "$$supabase_status" | grep -o '"API_URL": *"[^"]*"' | sed 's/"API_URL": *"//;s/"$$//' || true); \
		if [ -z "$$supabase_url" ]; then \
			supabase_api_port=$$(awk '/^\[api\]/ { in_api = 1; next } /^\[/ { in_api = 0 } in_api && /^[[:space:]]*port[[:space:]]*=/ { gsub(/[^0-9]/, "", $$0); print; exit }' supabase/config.toml); \
			supabase_url="http://127.0.0.1:$${supabase_api_port:-54321}"; \
		fi; \
		supabase_anon_key=$$(printf '%s\n' "$$supabase_status" | grep -o '"ANON_KEY": *"[^"]*"' | sed 's/"ANON_KEY": *"//;s/"$$//' || true); \
		if [ -z "$$supabase_anon_key" ]; then \
			supabase_anon_key=$$(printf '%s\n' "$$supabase_status" | grep -o '"PUBLISHABLE_KEY": *"[^"]*"' | sed 's/"PUBLISHABLE_KEY": *"//;s/"$$//' || true); \
		fi; \
		if [ -z "$$supabase_url" ] || [ -z "$$supabase_anon_key" ]; then \
			echo "Error: Failed to extract live Supabase Auth configuration" >&2; \
			printf '%s\n' "$$supabase_status" >&2; \
			exit 1; \
		fi; \
		{ \
			echo "# Runtime ports and auth env (auto-generated by make dev)"; \
			echo "POSTGRES_PORT=$(POSTGRES_PORT)"; \
			echo "DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:$(POSTGRES_PORT)/postgres"; \
			echo "MINIO_PORT=$(MINIO_PORT)"; \
			echo "R2_S3_API_ORIGIN=http://127.0.0.1:$(MINIO_PORT)"; \
			echo "R2_ACCESS_KEY_ID=$(R2_ACCESS_KEY_ID)"; \
			echo "R2_SECRET_ACCESS_KEY=$(R2_SECRET_ACCESS_KEY)"; \
			echo "R2_BUCKET=$(R2_BUCKET)"; \
			echo "R2_REGION=$(R2_REGION)"; \
			echo "SUPABASE_URL=$$supabase_url"; \
			echo "SUPABASE_ANON_KEY=$$supabase_anon_key"; \
			echo "SUPABASE_JWKS_URL=$$supabase_url/auth/v1/.well-known/jwks.json"; \
			echo "SUPABASE_ISSUER=$$supabase_url/auth/v1"; \
			echo "SUPABASE_AUDIENCES=authenticated"; \
			echo "NEXT_PUBLIC_SUPABASE_URL=$$supabase_url"; \
			echo "NEXT_PUBLIC_SUPABASE_ANON_KEY=$$supabase_anon_key"; \
		} > .dev-ports
	@echo "Services started. App Postgres: localhost:$(POSTGRES_PORT). MinIO: http://127.0.0.1:$(MINIO_PORT). Supabase Auth env written to .dev-ports"

down:
	@echo "Stopping local dev services..."
	@COMPOSE_PROJECT_NAME=$(LOCAL_COMPOSE_PROJECT) docker compose -f docker/docker-compose.yml down
	@supabase stop || true
	@rm -f .dev-ports

logs:
	COMPOSE_PROJECT_NAME=$(LOCAL_COMPOSE_PROJECT) docker compose -f docker/docker-compose.yml logs -f

clean:
	./scripts/agency_archive.sh

api:
	cd apps/api && PYTHONPATH=$$PWD/../../python DATABASE_URL=$(DATABASE_URL) \
		SUPABASE_AUTH_ADMIN_KEY= \
		STREAM_BASE_URL=$(STREAM_BASE_URL) \
		STREAM_CORS_ORIGINS=$(STREAM_CORS_ORIGINS) \
		uv run --project ../../python uvicorn main:app --reload --port $(API_PORT)

web:
	cd apps/web && \
		FASTAPI_BASE_URL=http://localhost:$(API_PORT) \
		NEXUS_ENV=$${NEXUS_ENV:-local} \
		NEXT_PUBLIC_SUPABASE_URL=$${NEXT_PUBLIC_SUPABASE_URL:-$(SUPABASE_URL)} \
		NEXT_PUBLIC_SUPABASE_ANON_KEY=$${NEXT_PUBLIC_SUPABASE_ANON_KEY:-$(SUPABASE_ANON_KEY)} \
		AUTH_ALLOWED_REDIRECT_ORIGINS=$${AUTH_ALLOWED_REDIRECT_ORIGINS:-$(AUTH_ALLOWED_REDIRECT_ORIGINS)} \
		bun run dev

worker-interactive:
	cd python && PYTHONPATH=$$PWD:$$PWD/.. DATABASE_URL=$(DATABASE_URL) \
		WORKER_LANE=interactive DATABASE_STATEMENT_TIMEOUT_MS=300000 \
		SUPABASE_AUTH_ADMIN_KEY= \
		uv run python -m apps.worker.main

worker-background:
	cd python && PYTHONPATH=$$PWD:$$PWD/.. DATABASE_URL=$(DATABASE_URL) \
		WORKER_LANE=background DATABASE_STATEMENT_TIMEOUT_MS=300000 \
		SUPABASE_AUTH_ADMIN_KEY= \
		uv run python -m apps.worker.main

migrate:
	cd migrations && DATABASE_URL=$(DATABASE_URL) \
		uv run --project ../python alembic upgrade head

migrate-down:
	cd migrations && DATABASE_URL=$(DATABASE_URL) \
		uv run --project ../python alembic downgrade -1

seed:
	cd python && DATABASE_URL=$(DATABASE_URL) \
		SUPABASE_URL=$(SUPABASE_URL) \
		uv run python ../scripts/seed_dev.py

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
	cd apps/android && ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest

build-android-release:
	cd apps/android && ./gradlew :app:lintRelease :app:assembleRelease

build-icons:
	node scripts/build-icons.mjs

generate-resource-capabilities:
	cd python && uv run python scripts/generate_resource_capabilities.py

smoke:
	./deploy/smoke/auth-smoke.sh

smoke-auth-redirects:
	./deploy/smoke/auth-redirect-construction-smoke.sh --mode prod-readonly
