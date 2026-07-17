import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Source-gate tests for the reader-profile persistence hard cutover
// (docs/cutovers/reader-profile-persistence-hard-cutover.md §12, negative gates).
// They read source text and assert the cutover's structural invariants so a
// regression (a reappearing frontend default, a second write owner, a bootstrap
// catch-and-default, a preference-column server default) fails CI even when the
// code still type-checks. Mirrors src/lib/workspace/firstPaintCutover.guards.test.ts:
// node `.test.ts` (unit project) reading files relative to process.cwd() (= apps/web).

const APP_ROOT = process.cwd();
const REPO_ROOT = join(APP_ROOT, "..", "..");

function appText(relativePath: string): string {
  return readFileSync(join(APP_ROOT, relativePath), "utf8");
}

function repoText(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

/** The text of one python function body, sliced to the next top-level def. */
function pythonFunction(source: string, name: string): string {
  const start = source.indexOf(`def ${name}(`);
  expect(start, `expected def ${name}( to exist`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n(?:async )?def /);
  return end === -1 ? source.slice(start) : source.slice(start, start + 1 + end);
}

describe("reader-profile persistence cutover gates", () => {
  // The bootstrap profile read is REQUIRED: normal 30 s deadline (no prefetch
  // bound, so no options argument), strict decode, and no catch-and-default.
  it("bootstrap reads /me/reader-profile with no prefetch bound and no catch", () => {
    const bootstrap = appText("src/lib/workspace/bootstrap.server.ts");
    expect(/\/me\/reader-profile["']\s*,/.test(bootstrap)).toBe(false);
    expect(bootstrap).toContain("parseReaderProfile(");

    const readerLoad = bootstrap.slice(
      bootstrap.indexOf("async function loadReaderProfile"),
      bootstrap.indexOf("async function loadSession"),
    );
    expect(readerLoad).not.toContain("catch");
    expect(readerLoad).not.toContain("PREFETCH_OPTS");
  });

  // No frontend default profile exists anywhere under src/.
  it("no DEFAULT_READER_PROFILE remains anywhere under src/", () => {
    const offenders: string[] = [];
    for (const relativePath of allSourceFiles(join(APP_ROOT, "src"))) {
      if (readFileSync(join(APP_ROOT, relativePath), "utf8").includes("DEFAULT_READER_PROFILE")) {
        offenders.push(relativePath);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The context is a strict capability: absence throws, no NOOP fallback, and
  // no generic raw save is exposed.
  it("useReaderContext defects on absence and exposes no raw save", () => {
    const context = appText("src/lib/reader/ReaderContext.tsx");
    expect(context).toContain("throw new Error");
    expect(context).not.toContain("NOOP");
    expect(/\bsave\s*[:(=]/.test(context)).toBe(false);
  });

  // Exactly one client write owner: useReaderProfile.ts is the only non-test
  // source referencing the profile BFF endpoint, and its PATCH sets keepalive.
  it("useReaderProfile.ts is the one write owner and every PATCH sets keepalive", () => {
    const referrers = allSourceFiles(join(APP_ROOT, "src")).filter((relativePath) =>
      readFileSync(join(APP_ROOT, relativePath), "utf8").includes("/api/me/reader-profile"),
    );
    expect(referrers).toEqual(["src/lib/reader/useReaderProfile.ts"]);

    const hook = appText("src/lib/reader/useReaderProfile.ts");
    expect(/method: "PATCH",[\s\S]*?keepalive: true/.test(hook)).toBe(true);
  });

  // The reader lib owns no storage mirror.
  it("the reader lib uses no browser storage", () => {
    for (const relativePath of allSourceFiles(join(APP_ROOT, "src/lib/reader"))) {
      const text = readFileSync(join(APP_ROOT, relativePath), "utf8");
      expect(text, `${relativePath} must not touch browser storage`).not.toMatch(
        /localStorage|indexedDB/i,
      );
    }
  });

  // The transcript panel receives its theme surface as props; the context read
  // and the duplicated font/theme derivation are gone.
  it("TranscriptContentPanel has no context read or theme derivation", () => {
    const panel = appText("src/app/(authenticated)/media/[id]/TranscriptContentPanel.tsx");
    expect(panel).not.toContain("useReaderContext");
    expect(panel).not.toContain("buildReaderSurfaceStyle");
  });

  // The Settings mount/save-time disabling workaround is deleted.
  it("SettingsReaderPaneBody has no mount or saving disable workaround", () => {
    const settings = appText("src/app/(authenticated)/settings/reader/SettingsReaderPaneBody.tsx");
    expect(settings).not.toContain("mounted");
  });

  // Backend: the profile DTO has no timestamp; storage metadata is created_at.
  it("reader-profile schemas and service expose no updated_at", () => {
    expect(repoText("python/nexus/schemas/reader.py")).not.toContain("updated_at");

    const service = repoText("python/nexus/services/reader.py");
    expect(service).toContain("READER_PROFILE_DEFAULTS");
    expect(pythonFunction(service, "get_reader_profile")).not.toContain("updated_at");
    expect(pythonFunction(service, "patch_reader_profile")).not.toContain("updated_at");
  });

  // Backend: preference columns carry no database defaults; the only
  // server_default on reader_profiles is created_at's database clock.
  it("reader_profiles preference columns have no server defaults", () => {
    const models = repoText("python/nexus/db/models.py");
    const start = models.indexOf("class ReaderProfile(");
    expect(start).toBeGreaterThan(-1);
    const rest = models.slice(start + 1);
    const end = rest.search(/\nclass /);
    const readerProfile = models.slice(start, start + 1 + end);
    expect(readerProfile.match(/server_default/g)).toHaveLength(1);
    expect(readerProfile).toContain("created_at");
    expect(readerProfile).not.toContain("updated_at");
  });

  // Backend: the widened outer no-store middleware covers both reader paths,
  // and the retryable-constraint set is owner-neutral with the profile pkey.
  it("the private no-store middleware and retryable constraints cover the profile", () => {
    const app = repoText("python/nexus/app.py");
    expect(app).toContain("READER_PRIVATE_NO_STORE_PATH_RE");
    expect(app).toContain("/media/[^/]+/reader-state|/me/reader-profile");
    expect(app).not.toContain("READER_STATE_PATH_RE");

    const retries = repoText("python/nexus/db/retries.py");
    expect(retries).toContain("RETRYABLE_UNIQUE_CONSTRAINTS");
    expect(retries).toContain('"reader_profiles_pkey"');
    expect(retries).not.toContain("AUTHOR_RETRYABLE");
  });
});

// Recursively list .ts/.tsx source files (excluding tests) under a dir, returned as
// paths relative to APP_ROOT — same traversal shape as the sibling source gates.
function allSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        return allSourceFiles(full);
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
        return [];
      }
      return [relative(APP_ROOT, full).split(sep).join("/")];
    })
    .sort();
}
