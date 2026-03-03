/**
 * Playwright globalSetup — runs once before any test project.
 *
 * Ensures seed data exists so tests never start against a missing
 * or stale .seed/ directory, regardless of how Playwright is invoked.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_DIR, "..");
const PDF_SEED = path.join(E2E_DIR, ".seed", "pdf-media.json");
const NON_PDF_SEED = path.join(E2E_DIR, ".seed", "non-pdf-media.json");
const EPUB_SEED = path.join(E2E_DIR, ".seed", "epub-media.json");
const YOUTUBE_SEED = path.join(E2E_DIR, ".seed", "youtube-media.json");

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }
  const raw = readFileSync(filePath, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.slice(0, eqIdx).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function run(label, command, cwd, envOverrides) {
  console.log(`[global-setup] ${label}...`);
  try {
    execSync(command, {
      cwd,
      stdio: "inherit",
      env: { ...process.env, ...envOverrides },
    });
  } catch {
    throw new Error(
      `[global-setup] "${label}" failed.\n` +
        `  Command: ${command}\n` +
        `  CWD:     ${cwd}\n` +
        "  Fix:     ensure local services are running (make dev)",
    );
  }
}

export default function globalSetup() {
  // Mirror Makefile behavior so direct `npm test` runs work too.
  loadEnvFile(path.join(ROOT, ".env"));
  loadEnvFile(path.join(ROOT, ".dev-ports"));

  // Skip seeding if all artifacts exist and SKIP_SEED is set.
  // Useful for rapid local re-runs where the DB hasn't changed.
  if (
    process.env.SKIP_SEED &&
    existsSync(PDF_SEED) &&
    existsSync(NON_PDF_SEED) &&
    existsSync(EPUB_SEED) &&
    existsSync(YOUTUBE_SEED)
  ) {
    console.log("[global-setup] SKIP_SEED set and seed artifacts exist — skipping.");
    return;
  }

  // Step 1: Ensure the E2E auth user exists in Supabase.
  run("Seed E2E user", "npx tsx seed-e2e-user.ts", E2E_DIR);

  // Step 2: Seed PDF, web articles, API keys, and EPUB via the Python service layer.
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      "[global-setup] DATABASE_URL is not set.\n" +
        "  Hint: source .env or run via `make test-e2e`.",
    );
  }
  run(
    "Seed E2E data",
    "uv run python scripts/seed_e2e_data.py",
    path.join(ROOT, "python"),
    {
      DATABASE_URL: dbUrl,
      NEXUS_ENV: process.env.NEXUS_ENV ?? "local",
    },
  );

  // Step 3: Verify all seed artifacts were created.
  if (!existsSync(PDF_SEED)) {
    throw new Error(
      `[global-setup] Seed script succeeded but ${PDF_SEED} was not created.\n` +
        "  This indicates a bug in python/scripts/seed_e2e_data.py.",
    );
  }
  if (!existsSync(NON_PDF_SEED)) {
    throw new Error(
      `[global-setup] Seed script succeeded but ${NON_PDF_SEED} was not created.\n` +
        "  This indicates a bug in python/scripts/seed_e2e_data.py.",
    );
  }
  if (!existsSync(EPUB_SEED)) {
    throw new Error(
      `[global-setup] Seed script succeeded but ${EPUB_SEED} was not created.\n` +
        "  This indicates a bug in python/scripts/seed_e2e_data.py.",
    );
  }
  if (!existsSync(YOUTUBE_SEED)) {
    throw new Error(
      `[global-setup] Seed script succeeded but ${YOUTUBE_SEED} was not created.\n` +
        "  This indicates a bug in python/scripts/seed_e2e_data.py.",
    );
  }

  console.log("[global-setup] Seeding complete.");
}
