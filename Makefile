# Nexus Development Makefile
# Run `make help` for available commands.

.PHONY: help setup dev down logs clean api web worker migrate migrate-test migrate-down seed seed-real-media-e2e \
	check check-back type-back check-front check-android check-workflows format format-back fix-front build build-android build-android-release build-icons audit \
	test-unit test test-back-unit test-back-integration test-front-unit test-front-browser \
	test-android test-migrations test-supabase test-real-media test-live-providers test-e2e test-e2e-ui \
	smoke verify verify-android verify-android-release verify-full \
	_ensure-node-ingest _ensure-e2e-deps _test-back-db-ready \
	_test-back-integration-raw _test-migrations-raw \
	_test-supabase-raw _test-real-media-raw _test-real-media-backend-raw _test-live-providers-raw \
	_seed-real-media-e2e-raw _test-e2e-raw _test-real-media-e2e-raw _test-e2e-ui-raw

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
DATABASE_URL_TEST ?= postgresql+psycopg://postgres:postgres@localhost:$(POSTGRES_PORT)/nexus_test
DATABASE_URL_TEST_MIGRATIONS ?= postgresql+psycopg://postgres:postgres@localhost:$(POSTGRES_PORT)/nexus_test_migrations

R2_ENDPOINT_URL ?= http://127.0.0.1:$(MINIO_PORT)
R2_ACCESS_KEY_ID ?= nexus-local-access-key
R2_SECRET_ACCESS_KEY ?= nexus-local-secret-key
R2_BUCKET ?= media
R2_REGION ?= us-east-1

WEB_PORT ?= 3000
API_PORT ?= 8000
PLAYWRIGHT_ARGS ?=

help:
	@echo "Nexus Development Commands"
	@echo ""
	@echo "Setup and run:"
	@echo "  make setup              - Install deps, start local services, run migrations"
	@echo "  make dev                - Start local Postgres, MinIO, and Supabase Auth"
	@echo "  make down               - Stop local dev services"
	@echo "  make api                - Start FastAPI on API_PORT (default 8000)"
	@echo "  make web                - Start Next.js on WEB_PORT (default 3000)"
	@echo "  make worker             - Start the Postgres queue worker"
	@echo ""
	@echo "Routine gates:"
	@echo "  make check              - Static checks only"
	@echo "  make type-back          - Backend type checking"
	@echo "  make check-workflows    - GitHub Actions lint/security checks"
	@echo "  make check-android      - Android lint"
	@echo "  make audit              - Dependency vulnerability audits"
	@echo "  make build-android      - Build Android debug and instrumentation APKs"
	@echo "  make build-android-release - Build signed Android release APK"
	@echo "  make build-icons        - Regenerate icons from apps/web/public/brand/asterism.svg"
	@echo "  make verify-android     - Android lint + debug/test APK build"
	@echo "  make verify-android-release - Build and verify signed Android release APK"
	@echo "  make test-unit          - Fast backend and frontend unit tests"
	@echo "  make test               - All non-E2E automated tests"
	@echo "  make test-e2e           - Default Playwright E2E tests"
	@echo "  make test-real-media    - Strict deterministic real-media backend + Playwright gates"
	@echo "  make test-live-providers  - Strict live-provider backend gate"
	@echo "  make verify             - check + build + test"
	@echo "  make verify-full        - verify + real-media + live-provider + default E2E gates"
	@echo "  make smoke              - Post-deploy auth smoke check against production URLs"
	@echo ""
	@echo "Focused targets:"
	@echo "  make type-back             - Backend type checking"
	@echo "  make check-workflows       - GitHub Actions lint/security checks"
	@echo "  make test-back-unit        - Backend unit tests only"
	@echo "  make test-back-integration - Backend DB/API integration tests"
	@echo "  make test-front-unit       - Frontend unit tests"
	@echo "  make test-front-browser    - Frontend browser component tests"
	@echo "  make test-android          - Android instrumentation tests on a connected device"
	@echo "  make test-migrations       - Alembic migration tests"
	@echo "  make test-supabase         - Supabase Auth integration tests"
	@echo "  make test-e2e-ui           - Playwright E2E in UI mode"
	@echo ""
	@echo "Formatting:"
	@echo "  make format             - Apply backend formatting and frontend lint fixes"
	@echo "  make format-back        - Format backend Python"
	@echo "  make fix-front          - Apply frontend ESLint fixes"
	@echo ""
	@echo "Database:"
	@echo "  make migrate            - Run migrations on the dev database"
	@echo "  make migrate-test       - Run migrations on the test database"
	@echo "  make migrate-down       - Roll back one dev migration"
	@echo "  make seed               - Seed development data"
	@echo "  make seed-real-media-e2e - Seed real-media E2E corpus through product paths"
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
			done; \
			docker exec "$$postgres_container" createdb -U postgres nexus_test >/dev/null 2>&1 || true; \
			docker exec "$$postgres_container" createdb -U postgres nexus_test_migrations >/dev/null 2>&1 || true
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
	@supabase start -x realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,postgres-meta,mailpit,postgrest
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
			echo "DATABASE_URL_TEST=postgresql+psycopg://postgres:postgres@localhost:$(POSTGRES_PORT)/nexus_test"; \
			echo "DATABASE_URL_TEST_MIGRATIONS=postgresql+psycopg://postgres:postgres@localhost:$(POSTGRES_PORT)/nexus_test_migrations"; \
			echo "MINIO_PORT=$(MINIO_PORT)"; \
			echo "R2_ENDPOINT_URL=http://127.0.0.1:$(MINIO_PORT)"; \
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

worker:
	cd python && PYTHONPATH=$$PWD:$$PWD/.. DATABASE_URL=$(DATABASE_URL) \
		SUPABASE_AUTH_ADMIN_KEY= \
		uv run python -m apps.worker.main

migrate:
	cd migrations && DATABASE_URL=$(DATABASE_URL) \
		uv run --project ../python alembic upgrade head

migrate-test:
	cd migrations && DATABASE_URL=$(DATABASE_URL_TEST) \
		uv run --project ../python alembic upgrade head

migrate-down:
	cd migrations && DATABASE_URL=$(DATABASE_URL) \
		uv run --project ../python alembic downgrade -1

seed:
	cd python && DATABASE_URL=$(DATABASE_URL) \
		SUPABASE_URL=$(SUPABASE_URL) \
		uv run python ../scripts/seed_dev.py

seed-real-media-e2e: _ensure-e2e-deps
	./scripts/with_supabase_services.sh ./scripts/with_test_services.sh sh -c 'trap "rm -f e2e/.seed/real-media.json" EXIT; rm -f e2e/.seed/real-media.json; make _seed-real-media-e2e-raw'

_seed-real-media-e2e-raw:
	cd e2e && bunx tsx seed-e2e-user.ts
	cd migrations && DATABASE_URL=$(DATABASE_URL) NEXUS_ENV=local \
		uv run --project ../python alembic upgrade head
	cd python && DATABASE_URL=$(DATABASE_URL) NEXUS_ENV=local \
		REAL_MEDIA_PROVIDER_FIXTURES=1 \
		REAL_MEDIA_FIXTURE_DIR=$$PWD/tests/fixtures/real_media \
		uv run python scripts/seed_real_media_e2e.py

check:
	make check-back
	make type-back
	make check-front
	make check-workflows

check-back:
	cd python && uv run ruff check .
	cd python && uv run ruff format --check .

type-back:
	cd python && uv run pyright

check-front:
	cd apps/web && bun run lint
	cd apps/web && bun run typecheck

check-android:
	cd apps/android && ./gradlew :app:lintDebug

check-workflows:
	actionlint .github/workflows/*.yml
	cd python && uv run zizmor ../.github/workflows

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

audit:
	cd python && uv sync --all-extras --locked
	cd python && uv export --locked --all-extras --no-emit-project \
		--no-emit-package llm-calling --no-emit-package web-search-tool \
		--format requirements.txt > /tmp/nexus-python-audit-requirements.txt
	cd python && uv run pip-audit --strict --no-deps --disable-pip \
		--requirement /tmp/nexus-python-audit-requirements.txt
	cd apps/web && bun audit --audit-level=high
	cd e2e && bun audit --audit-level=high
	cd node/ingest && bun audit --audit-level=high

test-unit:
	make test-back-unit
	make test-front-unit

test:
	make test-unit
	./scripts/with_test_services.sh make _test-back-db-ready _test-back-integration-raw _test-migrations-raw
	make test-front-browser

test-back-unit:
	cd python && NEXUS_ENV=test uv run pytest -v -n auto -m "unit and not integration"

test-back-integration:
	./scripts/with_test_services.sh make _test-back-db-ready _test-back-integration-raw

_test-back-db-ready:
	make migrate-test

_test-back-integration-raw:
	make _ensure-node-ingest
	cd python && NEXUS_ENV=test uv run pytest -v --tb=short \
		-m "integration and not unit and not supabase and not network and not slow" \
		--ignore=tests/test_migrations.py

test-front-unit:
	cd apps/web && bun run test:unit

test-front-browser:
	@if [ "$${CI:-}" = "true" ]; then \
		cd apps/web && bunx playwright install --with-deps chromium; \
	else \
		cd apps/web && bunx playwright install chromium; \
	fi
	cd apps/web && bun run test:browser

test-android:
	cd apps/android && ./gradlew :app:connectedDebugAndroidTest

test-migrations:
	./scripts/with_test_services.sh make _test-migrations-raw

_test-migrations-raw:
	cd python && DATABASE_URL=$(DATABASE_URL_TEST_MIGRATIONS) NEXUS_ENV=test \
		uv run pytest -v --tb=short tests/test_migrations.py

test-supabase:
	./scripts/with_supabase_services.sh ./scripts/with_test_services.sh make _test-back-db-ready _test-supabase-raw

_test-supabase-raw:
	cd python && NEXUS_ENV=test uv run pytest -v --tb=short \
		-m "supabase and not real_media and not live_provider"

test-real-media: _ensure-e2e-deps
	./scripts/with_supabase_services.sh ./scripts/with_test_services.sh sh -c 'trap "rm -f e2e/.seed/real-media.json" EXIT; rm -f e2e/.seed/real-media.json; make _test-real-media-raw'

_test-real-media-raw:
	make _test-back-db-ready _test-real-media-backend-raw
	make _test-real-media-e2e-raw

_test-real-media-backend-raw:
	make _ensure-node-ingest
	mkdir -p test-results
	cd python && NEXUS_ENV=local \
		REAL_MEDIA_PROVIDER_FIXTURES=1 \
		REAL_MEDIA_FIXTURE_DIR=$$PWD/tests/fixtures/real_media \
		uv run pytest -v --tb=short \
		--basetemp=../test-results/real-media-backend \
		-m real_media

test-live-providers:
	./scripts/with_supabase_services.sh ./scripts/with_test_services.sh make _test-back-db-ready _test-live-providers-raw

_test-live-providers-raw:
	make _ensure-node-ingest
	mkdir -p test-results
	cd python && NEXUS_ENV=local PODCAST_INITIAL_EPISODE_WINDOW=1 uv run pytest -v --tb=short \
		--basetemp=../test-results/live-providers \
		-m live_provider

test-e2e: _ensure-e2e-deps
	./scripts/with_supabase_services.sh ./scripts/with_test_services.sh make _test-e2e-raw

_test-e2e-raw:
	@API_PORT=$$(./scripts/find_port.sh $(API_PORT) api) && \
	WEB_PORT=$$(./scripts/find_port.sh $(WEB_PORT) web) && \
	echo "Running e2e with API_PORT=$$API_PORT WEB_PORT=$$WEB_PORT" && \
	cd e2e && \
	API_PORT=$$API_PORT WEB_PORT=$$WEB_PORT NEXUS_ENV=test E2E_REAL_MEDIA=0 bunx playwright install --with-deps chromium && \
	API_PORT=$$API_PORT WEB_PORT=$$WEB_PORT NEXUS_ENV=test E2E_REAL_MEDIA=0 bun run test:e2e -- $(PLAYWRIGHT_ARGS)

_test-real-media-e2e-raw:
	@API_PORT=$$(./scripts/find_port.sh $(API_PORT) api) && \
	WEB_PORT=$$(./scripts/find_port.sh $(WEB_PORT) web) && \
	echo "Running real-media e2e with API_PORT=$$API_PORT WEB_PORT=$$WEB_PORT" && \
	cd e2e && \
	API_PORT=$$API_PORT WEB_PORT=$$WEB_PORT NEXUS_ENV=local E2E_REAL_MEDIA=1 bunx playwright install --with-deps chromium && \
	API_PORT=$$API_PORT WEB_PORT=$$WEB_PORT NEXUS_ENV=local E2E_REAL_MEDIA=1 \
	REAL_MEDIA_PROVIDER_FIXTURES=1 \
	REAL_MEDIA_FIXTURE_DIR=$$PWD/../python/tests/fixtures/real_media \
	bun run test:e2e -- --project=real-media $(PLAYWRIGHT_ARGS)

test-e2e-ui: _ensure-e2e-deps
	./scripts/with_supabase_services.sh ./scripts/with_test_services.sh make _test-e2e-ui-raw

_test-e2e-ui-raw:
	@API_PORT=$$(./scripts/find_port.sh $(API_PORT) api) && \
	WEB_PORT=$$(./scripts/find_port.sh $(WEB_PORT) web) && \
	echo "Running e2e ui with API_PORT=$$API_PORT WEB_PORT=$$WEB_PORT" && \
	cd e2e && \
	API_PORT=$$API_PORT WEB_PORT=$$WEB_PORT NEXUS_ENV=test E2E_REAL_MEDIA=0 bunx playwright install chromium && \
	API_PORT=$$API_PORT WEB_PORT=$$WEB_PORT NEXUS_ENV=test E2E_REAL_MEDIA=0 bunx playwright test --ui

verify:
	make check
	make build
	make test
	@echo "=== verification passed ==="

verify-android:
	make check-android
	make build-android
	@echo "=== android verification passed ==="

verify-android-release:
	make build-android-release
	@set -eu; \
		sdk_root="$${ANDROID_HOME:-$${ANDROID_SDK_ROOT:-}}"; \
		if [ -z "$$sdk_root" ]; then \
			echo "Set ANDROID_HOME or ANDROID_SDK_ROOT to verify the release APK."; \
			exit 1; \
		fi; \
		apksigner="$${ANDROID_APK_SIGNER:-$$(find "$$sdk_root/build-tools" -name apksigner -type f | sort | tail -n 1)}"; \
		if [ -z "$$apksigner" ] || [ ! -x "$$apksigner" ]; then \
			echo "Could not find apksigner. Install Android SDK build-tools or set ANDROID_APK_SIGNER."; \
			exit 1; \
		fi; \
		if [ -z "$${NEXUS_ANDROID_RELEASE_CERT_SHA256:-}" ]; then \
			echo "Set NEXUS_ANDROID_RELEASE_CERT_SHA256 to verify the release APK signer."; \
			exit 1; \
		fi; \
		verify_output=$$("$$apksigner" verify --verbose --print-certs apps/android/app/build/outputs/apk/release/app-release.apk); \
		printf '%s\n' "$$verify_output"; \
		actual_cert_sha256=$$(printf '%s\n' "$$verify_output" | sed -n -e 's/^Signer #1 certificate SHA-256 digest: //p' -e 's/^V[0-9][^:]* Signer: certificate SHA-256 digest: //p' | head -n 1 | tr -d ' :' | tr '[:lower:]' '[:upper:]'); \
		expected_cert_sha256=$$(printf '%s' "$$NEXUS_ANDROID_RELEASE_CERT_SHA256" | tr -d ' :' | tr '[:lower:]' '[:upper:]'); \
		if [ -z "$$actual_cert_sha256" ] || [ "$$actual_cert_sha256" != "$$expected_cert_sha256" ]; then \
			echo "Release APK signer does not match NEXUS_ANDROID_RELEASE_CERT_SHA256."; \
			exit 1; \
		fi; \
		shasum -a 256 apps/android/app/build/outputs/apk/release/app-release.apk
	@echo "=== android release verification passed ==="

verify-full:
	make verify
	make test-real-media
	make test-live-providers
	make test-e2e
	@echo "=== full verification passed ==="

smoke:
	./deploy/smoke/auth-smoke.sh

_ensure-node-ingest:
	@if [ ! -d "node/ingest/node_modules" ]; then \
		echo "Installing Node.js ingest worker dependencies..."; \
		cd node/ingest && bun install --frozen-lockfile; \
	fi

_ensure-e2e-deps:
	@if [ ! -d "e2e/node_modules" ]; then \
		echo "Installing E2E dependencies..."; \
		cd e2e && bun install --frozen-lockfile; \
	fi
