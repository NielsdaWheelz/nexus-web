# Nexus Development Makefile
# Run `make help` for available commands

.PHONY: help setup dev down test test-migrations test-all test-web lint lint-web fmt clean api web migrate migrate-test seed

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
	@echo "  make setup     - Full project setup (deps + services + migrations)"
	@echo "  make dev       - Start development services (postgres, redis)"
	@echo "  make down      - Stop development services"
	@echo ""
	@echo "Python:"
	@echo "  make test            - Run backend tests (excludes migration tests)"
	@echo "  make test-migrations - Run migration tests (separate database)"
	@echo "  make test-all        - Run all tests (backend + frontend)"
	@echo "  make lint            - Run backend linter"
	@echo "  make fmt             - Format backend code"
	@echo "  make clean           - Clean generated files"
	@echo ""
	@echo "Frontend:"
	@echo "  make test-web        - Run frontend tests"
	@echo "  make lint-web        - Run frontend linter"
	@echo ""
	@echo "Run:"
	@echo "  make api       - Start API server (port 8000)"
	@echo "  make web       - Start web frontend (port 3000)"
	@echo "  make migrate   - Run database migrations (dev)"
	@echo "  make migrate-test - Run migrations on test database"
	@echo "  make seed      - Seed development data"
	@echo ""
	@echo "Configuration (via environment or .env file):"
	@echo "  POSTGRES_PORT  - PostgreSQL port (default: 5432)"
	@echo "  REDIS_PORT     - Redis port (default: 6379)"
	@echo "  WEB_PORT       - Web frontend port (default: 3000)"
	@echo ""

# === Setup ===

setup:
	POSTGRES_PORT=$(POSTGRES_PORT) REDIS_PORT=$(REDIS_PORT) ./scripts/agency_setup.sh

dev:
	cd docker && POSTGRES_PORT=$(POSTGRES_PORT) REDIS_PORT=$(REDIS_PORT) docker compose up -d

down:
	cd docker && docker compose down

# === Python ===

test:
	cd python && DATABASE_URL=$(DATABASE_URL_BASE)/nexus_test NEXUS_ENV=test uv run pytest -v --ignore=tests/test_migrations.py

test-migrations:
	cd python && DATABASE_URL=$(DATABASE_URL_BASE)/nexus_test_migrations NEXUS_ENV=test uv run pytest -v tests/test_migrations.py

test-all: test test-migrations test-web

test-web:
	cd apps/web && npm test -- --passWithNoTests

lint:
	cd python && uv run ruff check .

lint-web:
	cd apps/web && npm run lint

fmt:
	cd python && uv run ruff format .

clean:
	./scripts/agency_archive.sh

# === Run ===

api:
	cd apps/api && PYTHONPATH=$$PWD/../../python DATABASE_URL=$(DATABASE_URL_BASE)/nexus_dev \
		uv run --project ../../python uvicorn main:app --reload

web:
	cd apps/web && \
		FASTAPI_BASE_URL=http://localhost:8000 \
		NEXUS_ENV=local \
		npm run dev

migrate:
	cd migrations && DATABASE_URL=$(DATABASE_URL_BASE)/nexus_dev \
		uv run --project ../python alembic upgrade head

migrate-test:
	cd migrations && DATABASE_URL=$(DATABASE_URL_BASE)/nexus_test \
		uv run --project ../python alembic upgrade head

seed:
	cd python && DATABASE_URL=$(DATABASE_URL_BASE)/nexus_dev \
		uv run python ../scripts/seed_dev.py

# === Verify ===

verify:
	./scripts/agency_verify.sh
