# Nexus Development Makefile
# Run `make help` for available commands

.PHONY: help setup dev down test lint fmt clean api worker migrate

help:
	@echo "Nexus Development Commands"
	@echo ""
	@echo "Setup:"
	@echo "  make setup     - Full project setup (deps + services + migrations)"
	@echo "  make dev       - Start development services (postgres, redis)"
	@echo "  make down      - Stop development services"
	@echo ""
	@echo "Python:"
	@echo "  make test      - Run all tests"
	@echo "  make lint      - Run linter"
	@echo "  make fmt       - Format code"
	@echo "  make clean     - Clean generated files"
	@echo ""
	@echo "Run:"
	@echo "  make api       - Start API server"
	@echo "  make migrate   - Run database migrations"
	@echo ""

# === Setup ===

setup:
	./scripts/agency_setup.sh

dev:
	cd docker && docker compose up -d

down:
	cd docker && docker compose down

# === Python ===

test:
	cd python && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/nexus_test uv run pytest -v

lint:
	cd python && uv run ruff check .

fmt:
	cd python && uv run ruff format .

clean:
	./scripts/agency_archive.sh

# === Run ===

api:
	cd apps/api && PYTHONPATH=$$PWD/../../python DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/nexus_dev \
		uv run --project ../../python uvicorn main:app --reload

migrate:
	cd migrations && DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5432/nexus_dev \
		uv run --project ../python alembic upgrade head

# === Verify ===

verify:
	./scripts/agency_verify.sh
