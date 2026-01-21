# Nexus Development Makefile
# Run `make help` for available commands

.PHONY: help setup dev down test test-back test-front test-migrations lint lint-back lint-front fmt fmt-back fmt-front clean api web worker migrate migrate-test migrate-down seed infra-up infra-down infra-logs verify

# Load .env file if it exists (created by setup)
-include .env
export

# Configurable ports (override with environment variables or .env file)
POSTGRES_PORT ?= 5432
REDIS_PORT ?= 6379
WEB_PORT ?= 3000
DATABASE_URL_BASE ?= postgresql+psycopg://postgres:postgres@localhost:$(POSTGRES_PORT)

help:
	@echo "Nexus Development Commands"
	@echo ""
	@echo "Setup:"
	@echo "  make setup          - Full project setup (deps + services + migrations)"
	@echo "  make dev            - Start development services (postgres, redis)"
	@echo "  make down           - Stop development services"
	@echo "  make clean          - Clean generated files"
	@echo ""
	@echo "Test:"
	@echo "  make test           - Run all tests (backend + frontend)"
	@echo "  make test-back      - Run backend tests (excludes migrations)"
	@echo "  make test-front     - Run frontend tests"
	@echo "  make test-migrations - Run migration tests (separate database)"
	@echo ""
	@echo "Lint:"
	@echo "  make lint           - Run all linters (backend + frontend)"
	@echo "  make lint-back      - Run backend linter"
	@echo "  make lint-front     - Run frontend linter"
	@echo ""
	@echo "Format:"
	@echo "  make fmt            - Format all code (backend + frontend)"
	@echo "  make fmt-back       - Format backend code"
	@echo "  make fmt-front      - Fix frontend lint issues"
	@echo ""
	@echo "Run:"
	@echo "  make api            - Start API server (port 8000)"
	@echo "  make web            - Start web frontend (port 3000)"
	@echo "  make worker         - Start Celery worker"
	@echo ""
	@echo "Database:"
	@echo "  make migrate        - Run migrations (dev database)"
	@echo "  make migrate-test   - Run migrations (test database)"
	@echo "  make migrate-down   - Rollback one migration"
	@echo "  make seed           - Seed development data"
	@echo ""
	@echo "Infrastructure:"
	@echo "  make infra-up       - Start infrastructure (postgres, redis)"
	@echo "  make infra-down     - Stop infrastructure"
	@echo "  make infra-logs     - Show infrastructure logs"
	@echo ""
	@echo "Verify:"
	@echo "  make verify         - Run full verification (lint + test)"
	@echo ""
	@echo "Configuration (via environment or .env file):"
	@echo "  POSTGRES_PORT       - PostgreSQL port (default: 5432)"
	@echo "  REDIS_PORT          - Redis port (default: 6379)"
	@echo "  WEB_PORT            - Web frontend port (default: 3000)"
	@echo ""

# === Setup ===

setup:
	POSTGRES_PORT=$(POSTGRES_PORT) REDIS_PORT=$(REDIS_PORT) ./scripts/agency_setup.sh

dev:
	cd docker && POSTGRES_PORT=$(POSTGRES_PORT) REDIS_PORT=$(REDIS_PORT) docker compose up -d

down:
	cd docker && docker compose down

clean:
	./scripts/agency_archive.sh

# === Test ===

test: test-back test-migrations test-front

test-back:
	cd python && DATABASE_URL=$(DATABASE_URL_BASE)/nexus_test NEXUS_ENV=test uv run pytest -v --ignore=tests/test_migrations.py

test-front:
	cd apps/web && npm test -- --passWithNoTests

test-migrations:
	cd python && DATABASE_URL=$(DATABASE_URL_BASE)/nexus_test_migrations REDIS_URL=redis://localhost:$(REDIS_PORT)/0 NEXUS_ENV=test uv run pytest -v tests/test_migrations.py

# === Lint ===

lint: lint-back lint-front

lint-back:
	cd python && uv run ruff check .

lint-front:
	cd apps/web && npm run lint

# === Format ===

fmt: fmt-back fmt-front

fmt-back:
	cd python && uv run ruff format .

fmt-front:
	cd apps/web && npm run lint -- --fix

# === Run ===

api:
	cd apps/api && PYTHONPATH=$$PWD/../../python DATABASE_URL=$(DATABASE_URL_BASE)/nexus_dev \
		uv run --project ../../python uvicorn main:app --reload

web:
	cd apps/web && \
		FASTAPI_BASE_URL=http://localhost:8000 \
		NEXUS_ENV=local \
		npm run dev

worker:
	cd python && PYTHONPATH=$$PWD \
		DATABASE_URL=$(DATABASE_URL_BASE)/nexus_dev \
		REDIS_URL=redis://localhost:$(REDIS_PORT)/0 \
		CELERY_BROKER_URL=redis://localhost:$(REDIS_PORT)/0 \
		CELERY_RESULT_BACKEND=redis://localhost:$(REDIS_PORT)/0 \
		uv run celery -A apps.worker.main worker --loglevel=info

# === Database ===

migrate:
	cd migrations && DATABASE_URL=$(DATABASE_URL_BASE)/nexus_dev \
		uv run --project ../python alembic upgrade head

migrate-test:
	cd migrations && DATABASE_URL=$(DATABASE_URL_BASE)/nexus_test \
		uv run --project ../python alembic upgrade head

migrate-down:
	cd migrations && DATABASE_URL=$(DATABASE_URL_BASE)/nexus_dev \
		uv run --project ../python alembic downgrade -1

seed:
	cd python && DATABASE_URL=$(DATABASE_URL_BASE)/nexus_dev \
		uv run python ../scripts/seed_dev.py

# === Infrastructure ===

infra-up:
	docker compose -f docker/docker-compose.yml up -d

infra-down:
	docker compose -f docker/docker-compose.yml down

infra-logs:
	docker compose -f docker/docker-compose.yml logs -f

# === Verify ===

verify:
	./scripts/agency_verify.sh
