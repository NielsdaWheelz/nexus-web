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
import { applyResolvedSupabaseEnv } from "./supabase-env.mjs";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_DIR, "..");
const PDF_SEED = path.join(E2E_DIR, ".seed", "pdf-media.json");
const NON_PDF_SEED = path.join(E2E_DIR, ".seed", "non-pdf-media.json");
const EPUB_SEED = path.join(E2E_DIR, ".seed", "epub-media.json");
const YOUTUBE_SEED = path.join(E2E_DIR, ".seed", "youtube-media.json");
const READER_RESUME_SEED = path.join(E2E_DIR, ".seed", "reader-resume-media.json");
const SEED_FILES = [PDF_SEED, NON_PDF_SEED, EPUB_SEED, YOUTUBE_SEED, READER_RESUME_SEED];
const E2E_USER_EMAIL = process.env.E2E_USER_EMAIL ?? "e2e-test@nexus.local";

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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function seedArtifactsExist() {
  return SEED_FILES.every((filePath) => existsSync(filePath));
}

function readSeededMediaIds() {
  const pdf = readJson(PDF_SEED);
  const nonPdf = readJson(NON_PDF_SEED);
  const epub = readJson(EPUB_SEED);
  const youtube = readJson(YOUTUBE_SEED);
  const readerResume = readJson(READER_RESUME_SEED);

  return Array.from(
    new Set(
      [
        pdf.media_id,
        pdf.password_media_id,
        nonPdf.media_id,
        epub.media_id,
        youtube.media_id,
        youtube.playback_only_media_id,
        readerResume.web_media_id,
        readerResume.epub_media_id,
        readerResume.pdf_media_id,
      ].filter((value) => typeof value === "string" && value.length > 0),
    ),
  );
}

function databaseHasSeededMedia(dbUrl) {
  if (!seedArtifactsExist()) {
    return false;
  }

  const probeDatabaseUrl = dbUrl.replace(/^postgresql\+psycopg:\/\//, "postgresql://");
  const mediaIds = readSeededMediaIds();
  if (mediaIds.length === 0) {
    return false;
  }

  const command =
    "uv run --project python python -c " +
    JSON.stringify(
      "import json, os, psycopg;" +
        "ids=json.loads(os.environ['NEXUS_E2E_MEDIA_IDS']);" +
        "conn=psycopg.connect(os.environ['DATABASE_URL']);" +
        "cur=conn.cursor();" +
        "cur.execute('select count(*) from media where id = any(%s::uuid[])', (ids,));" +
        "row=cur.fetchone();" +
        "print(row[0] if row else 0);" +
        "cur.close();" +
        "conn.close()",
    );

  try {
    const raw = execSync(command, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        DATABASE_URL: probeDatabaseUrl,
        NEXUS_E2E_MEDIA_IDS: JSON.stringify(mediaIds),
      },
    })
      .toString()
      .trim();
    const count = Number.parseInt(raw, 10);
    return Number.isFinite(count) && count === mediaIds.length;
  } catch (error) {
    throw new Error(
      "[global-setup] Seed readiness probe failed.\n" +
        `  Command: ${command}\n` +
        `  CWD:     ${ROOT}\n` +
        `  Cause:   ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function databaseHasReadyEvidenceIndexes(dbUrl) {
  if (!seedArtifactsExist()) {
    return false;
  }

  const probeDatabaseUrl = dbUrl.replace(/^postgresql\+psycopg:\/\//, "postgresql://");
  const pdf = readJson(PDF_SEED);
  const nonPdf = readJson(NON_PDF_SEED);
  const epub = readJson(EPUB_SEED);
  const youtube = readJson(YOUTUBE_SEED);
  const readerResume = readJson(READER_RESUME_SEED);
  const mediaIds = Array.from(
    new Set(
      [
        pdf.media_id,
        nonPdf.media_id,
        epub.media_id,
        youtube.media_id,
        readerResume.web_media_id,
        readerResume.epub_media_id,
        readerResume.pdf_media_id,
      ].filter((value) => typeof value === "string" && value.length > 0),
    ),
  );
  if (mediaIds.length === 0) {
    return false;
  }

  const command =
    "uv run --project python python -c " +
    JSON.stringify(
      "import json, os, psycopg;" +
        "ids=json.loads(os.environ['NEXUS_E2E_INDEX_MEDIA_IDS']);" +
        "conn=psycopg.connect(os.environ['DATABASE_URL']);" +
        "cur=conn.cursor();" +
        "cur.execute(" +
        JSON.stringify(
          "select count(*) from media_content_index_states where media_id = any(%s::uuid[]) and status = 'ready'"
        ) +
        ", (ids,));" +
        "row=cur.fetchone();" +
        "print(row[0] if row else 0);" +
        "cur.close();" +
        "conn.close()",
    );

  try {
    const raw = execSync(command, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        DATABASE_URL: probeDatabaseUrl,
        NEXUS_E2E_INDEX_MEDIA_IDS: JSON.stringify(mediaIds),
      },
    })
      .toString()
      .trim();
    const count = Number.parseInt(raw, 10);
    return Number.isFinite(count) && count === mediaIds.length;
  } catch (error) {
    throw new Error(
      "[global-setup] Evidence-index readiness probe failed.\n" +
        `  Command: ${command}\n` +
        `  CWD:     ${ROOT}\n` +
        `  Cause:   ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function databaseHasSeededBilling(dbUrl) {
  const probeDatabaseUrl = dbUrl.replace(/^postgresql\+psycopg:\/\//, "postgresql://");
  const command =
    "uv run --project python python -c " +
    JSON.stringify(
      "import os, psycopg;" +
        "conn=psycopg.connect(os.environ['DATABASE_URL']);" +
        "cur=conn.cursor();" +
        "cur.execute(" +
        JSON.stringify(
          "select ba.plan_tier from billing_accounts ba join users u on u.id = ba.user_id where u.email = %s"
        ) +
        ", (os.environ['E2E_USER_EMAIL'],));" +
        "row=cur.fetchone();" +
        "print(row[0] if row else '');" +
        "cur.close();" +
        "conn.close()",
    );

  try {
    const planTier = execSync(command, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        DATABASE_URL: probeDatabaseUrl,
        E2E_USER_EMAIL,
      },
    })
      .toString()
      .trim();
    return planTier === "ai_plus";
  } catch (error) {
    throw new Error(
      "[global-setup] Billing readiness probe failed.\n" +
        `  Command: ${command}\n` +
        `  CWD:     ${ROOT}\n` +
        `  Cause:   ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function databaseHasSeededYoutubeTranscriptStates(dbUrl) {
  if (!seedArtifactsExist()) {
    return false;
  }

  const probeDatabaseUrl = dbUrl.replace(/^postgresql\+psycopg:\/\//, "postgresql://");
  const youtube = readJson(YOUTUBE_SEED);
  const command =
    "uv run --project python python -c " +
    JSON.stringify(
      "import json, os, psycopg;" +
        "seed=json.loads(os.environ['NEXUS_E2E_YOUTUBE_SEED']);" +
        "conn=psycopg.connect(os.environ['DATABASE_URL']);" +
        "cur=conn.cursor();" +
        "cur.execute(" +
        JSON.stringify(
          "select mts.media_id::text, mts.transcript_state, mts.transcript_coverage, mts.semantic_status, mcis.status from media_transcript_states mts left join media_content_index_states mcis on mcis.media_id = mts.media_id where mts.media_id = any(%s::uuid[])"
        ) +
        ", ([seed['media_id'], seed['playback_only_media_id']],));" +
        "rows={media_id:(state, coverage, semantic, index_status) for media_id, state, coverage, semantic, index_status in cur.fetchall()};" +
        "ready_ok=rows.get(seed['media_id']) == ('ready', 'full', 'ready', 'ready');" +
        "playback_ok=(rows.get(seed['playback_only_media_id']) or ('', '', ''))[0] == 'unavailable';" +
        "print('1' if ready_ok and playback_ok else '0');" +
        "cur.close();" +
        "conn.close()",
    );

  try {
    const raw = execSync(command, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        DATABASE_URL: probeDatabaseUrl,
        NEXUS_E2E_YOUTUBE_SEED: JSON.stringify(youtube),
      },
    })
      .toString()
      .trim();
    return raw === "1";
  } catch (error) {
    throw new Error(
      "[global-setup] YouTube transcript-state readiness probe failed.\n" +
        `  Command: ${command}\n` +
        `  CWD:     ${ROOT}\n` +
        `  Cause:   ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function databaseHasCleanSeededHighlightFixtures(dbUrl) {
  if (!seedArtifactsExist()) {
    return false;
  }

  const probeDatabaseUrl = dbUrl.replace(/^postgresql\+psycopg:\/\//, "postgresql://");
  const nonPdf = readJson(NON_PDF_SEED);
  const epub = readJson(EPUB_SEED);
  const command =
    "uv run --project python python -c " +
    JSON.stringify(
      "import json, os, psycopg;" +
        "seed=json.loads(os.environ['NEXUS_E2E_HIGHLIGHT_SEED']);" +
        "conn=psycopg.connect(os.environ['DATABASE_URL']);" +
        "cur=conn.cursor();" +
        "cur.execute(" +
        JSON.stringify(
          "select count(*), bool_and(id::text = any(%s::text[])) from highlights where id in (select h.id from highlights h join highlight_fragment_anchors hfa on hfa.highlight_id = h.id join fragments f on f.id = hfa.fragment_id where f.media_id = %s::uuid)"
        ) +
        ", (seed['non_pdf_highlight_ids'], seed['non_pdf_media_id']));" +
        "non_pdf_count, non_pdf_only_seed = cur.fetchone();" +
        "cur.execute(" +
        JSON.stringify(
          "select count(*) from highlights where id in (select h.id from highlights h join highlight_fragment_anchors hfa on hfa.highlight_id = h.id join fragments f on f.id = hfa.fragment_id where f.media_id = %s::uuid)"
        ) +
        ", (seed['epub_media_id'],));" +
        "epub_count = cur.fetchone()[0];" +
        "print('1' if non_pdf_count == 2 and bool(non_pdf_only_seed) and epub_count == 0 else '0');" +
        "cur.close();" +
        "conn.close()",
    );

  try {
    const raw = execSync(command, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        DATABASE_URL: probeDatabaseUrl,
        NEXUS_E2E_HIGHLIGHT_SEED: JSON.stringify({
          non_pdf_media_id: nonPdf.media_id,
          non_pdf_highlight_ids: [nonPdf.quote_highlight_id, nonPdf.focus_highlight_id],
          epub_media_id: epub.media_id,
        }),
      },
    })
      .toString()
      .trim();
    return raw === "1";
  } catch (error) {
    throw new Error(
      "[global-setup] Highlight-fixture readiness probe failed.\n" +
        `  Command: ${command}\n` +
        `  CWD:     ${ROOT}\n` +
        `  Cause:   ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export default function globalSetup() {
  // Mirror Makefile behavior so direct `bun test` runs work too.
  loadEnvFile(path.join(ROOT, ".env"));
  loadEnvFile(path.join(ROOT, ".dev-ports"));
  applyResolvedSupabaseEnv(ROOT, process.env);

  // Always ensure the auth bootstrap user exists before setup-project login runs.
  run("Seed E2E user", "bunx tsx seed-e2e-user.ts", E2E_DIR);

  // Step 1: Ensure schema is up-to-date for feature E2E coverage.
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      "[global-setup] DATABASE_URL is not set.\n" +
        "  Hint: source .env or run via `make test-e2e`.",
    );
  }
  run(
    "Apply DB migrations",
    "uv run --project ../python alembic upgrade head",
    path.join(ROOT, "migrations"),
    {
      DATABASE_URL: dbUrl,
      NEXUS_ENV: process.env.NEXUS_ENV ?? "test",
    },
  );

  if (
    databaseHasSeededMedia(dbUrl) &&
    databaseHasReadyEvidenceIndexes(dbUrl) &&
    databaseHasSeededBilling(dbUrl) &&
    databaseHasSeededYoutubeTranscriptStates(dbUrl) &&
    databaseHasCleanSeededHighlightFixtures(dbUrl)
  ) {
    console.log("[global-setup] Seed data already matches the database — skipping reseed.");
    return;
  }

  // Step 2: Seed PDF, web, EPUB, and reader-resume fixtures.
  run(
    "Seed E2E data",
    "uv run python scripts/seed_e2e_data.py",
    path.join(ROOT, "python"),
    {
      DATABASE_URL: dbUrl,
      NEXUS_ENV: process.env.NEXUS_ENV ?? "test",
    },
  );

  // Step 3: Verify all seed artifacts were created.
  const missingSeedFile = SEED_FILES.find((filePath) => !existsSync(filePath));
  if (missingSeedFile) {
    throw new Error(
      `[global-setup] Seed script succeeded but ${missingSeedFile} was not created.\n` +
        "  This indicates a bug in python/scripts/seed_e2e_data.py.",
    );
  }

  console.log("[global-setup] Seeding complete.");
}
