# Nexus Development Makefile
# Run `make help` for available commands

.PHONY: help setup dev down test test-migrations test-all lint fmt clean api worker migrate migrate-test

# Load .env file if it exists (created by setup)
-include .env
export

# Configurable ports (override with environment variables or .env file)
POSTGRES_PORT ?= 5432
REDIS_PORT ?= 6379
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
	@echo "  make test            - Run tests (excludes migration tests)"
	@echo "  make test-migrations - Run migration tests (separate database)"
	@echo "  make test-all        - Run all tests"
	@echo "  make lint            - Run linter"
	@echo "  make fmt             - Format code"
	@echo "  make clean           - Clean generated files"
	@echo ""
	@echo "Run:"
	@echo "  make api       - Start API server"
	@echo "  make migrate   - Run database migrations (dev)"
	@echo "  make migrate-test - Run migrations on test database"
	@echo ""
	@echo "Configuration (via environment or .env file):"
	@echo "  POSTGRES_PORT  - PostgreSQL port (default: 5432)"
	@echo "  REDIS_PORT     - Redis port (default: 6379)"
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

test-all: test test-migrations

lint:
	cd python && uv run ruff check .

fmt:
	cd python && uv run ruff format .

clean:
	./scripts/agency_archive.sh

# === Run ===

api:
	cd apps/api && PYTHONPATH=$$PWD/../../python DATABASE_URL=$(DATABASE_URL_BASE)/nexus_dev \
		uv run --project ../../python uvicorn main:app --reload

migrate:
	cd migrations && DATABASE_URL=$(DATABASE_URL_BASE)/nexus_dev \
		uv run --project ../python alembic upgrade head

migrate-test:
	cd migrations && DATABASE_URL=$(DATABASE_URL_BASE)/nexus_test \
		uv run --project ../python alembic upgrade head

# === Verify ===

verify:
	./scripts/agency_verify.sh
