import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Source-gate tests for the first-paint streaming + server-side restore hard cutover
// (docs/cutovers/first-paint-speed-streaming-and-restore-hard-cutover.md §8, R1–R6).
// These read source text and assert the cutover's structural invariants so a regression
// (re-introducing a serial waterfall, a client restore round-trip, a localStorage device
// key, etc.) fails CI even when the code still type-checks and runs. Mirrors the existing
// source-gate style in src/lib/api/effect-discipline.test.ts and src/app/api/proxy-routes.test.ts:
// node `.test.ts` (unit project) reading files relative to process.cwd() (= apps/web).

// apps/web (vitest cwd). The repo root is two levels up — R5 lives outside apps/web.
const APP_ROOT = process.cwd();
const REPO_ROOT = join(APP_ROOT, "..", "..");

function appText(relativePath: string): string {
  return readFileSync(join(APP_ROOT, relativePath), "utf8");
}

describe("first-paint streaming + server-restore cutover gates", () => {
  // R1 — the authenticated layout streams the chrome skeleton first: it has a <Suspense>
  // boundary and runs ONLY local work above it (verifySession / loadRenderEnvironment).
  // The data root (loadWorkspaceBootstrap / callFastAPI) must live BELOW the boundary, so
  // no networked await gates the first byte.
  it("R1: authenticated layout has a Suspense boundary and no data root above it", () => {
    const layout = appText("src/app/(authenticated)/layout.tsx");
    expect(layout).toContain("<Suspense");
    expect(layout).not.toContain("loadWorkspaceBootstrap");
    expect(layout).not.toContain("callFastAPI");
  });

  // R2a — the localStorage device identity is gone everywhere under src/: no getInstallationId,
  // no nexus.installationId, and the old localStorage owner file no longer exists.
  it("R2: no localStorage device identity exists anywhere under src/", () => {
    expect(existsSync(join(APP_ROOT, "src/lib/workspace/deviceId.ts"))).toBe(false);

    const offenders: string[] = [];
    for (const relativePath of allSourceFiles(join(APP_ROOT, "src"))) {
      const text = readFileSync(join(APP_ROOT, relativePath), "utf8");
      if (text.includes("getInstallationId") || text.includes("nexus.installationId")) {
        offenders.push(relativePath);
      }
    }
    expect(offenders).toEqual([]);
  });

  // R2b — the client transport never sends device_id; the BFF injects it from the cookie.
  it("R2: the client transport (sessionSync.ts) never sends device_id", () => {
    expect(appText("src/lib/workspace/sessionSync.ts")).not.toContain("device_id");
  });

  // R3 — the server bootstrap parallelizes its fetches through Promise.all and has no serial
  // `await callFastAPI(...)` … `await callFastAPI(...)` chain. The robust check: Promise.all(
  // is present, and the serial-chain regex (two awaited callFastAPI calls with only
  // whitespace/non-await text between them) does NOT match.
  it("R3: the server bootstrap fetches via Promise.all, not a serial callFastAPI chain", () => {
    const bootstrap = appText("src/lib/workspace/bootstrap.server.ts");
    expect(bootstrap).toContain("Promise.all(");
    // A serial chain is `await callFastAPI(` followed by another `await callFastAPI(` with no
    // intervening `await` (i.e. one fetch's result is not awaited concurrently with the next).
    // [\s\S] matches across newlines without the `s` (dotAll) flag, which needs an es2018+ target.
    const serialChain = /await callFastAPI\((?:(?!await )[\s\S])*?await callFastAPI\(/;
    expect(serialChain.test(bootstrap)).toBe(false);
  });

  // R4a — no client restore round-trip: useWorkspaceSession does not import or call
  // getWorkspaceSession (restore is server-side; the hook only captures + flushes).
  it("R4: useWorkspaceSession does not import or call getWorkspaceSession", () => {
    expect(appText("src/lib/workspace/useWorkspaceSession.ts")).not.toContain(
      "getWorkspaceSession",
    );
  });

  // R4b — sessionSync is transport-only: it exports putWorkspaceSession and no longer owns the
  // pure restore helpers (they moved to workspaceRestore.ts).
  it("R4: sessionSync exports putWorkspaceSession and none of the moved restore helpers", () => {
    const sessionSync = appText("src/lib/workspace/sessionSync.ts");
    expect(sessionSync).toContain("export async function putWorkspaceSession");
    expect(sessionSync).not.toContain("prepareRestoredState");
    expect(sessionSync).not.toContain("workspaceStatesEqual");
    expect(sessionSync).not.toContain("isNonTrivialSession");
  });

  // R5 — the First Load JS bundle budget is wired into CI: the repo-root Makefile has a
  // `check-bundle` target and ci.yml references it. These live OUTSIDE apps/web; resolve them
  // from REPO_ROOT (two levels up). If genuinely unreadable, surface that rather than passing.
  it("R5: check-bundle is a Makefile target and is referenced by CI", () => {
    const makefilePath = join(REPO_ROOT, "Makefile");
    const ciPath = join(REPO_ROOT, ".github/workflows/ci.yml");
    expect(
      existsSync(makefilePath),
      `expected repo-root Makefile at ${makefilePath}`,
    ).toBe(true);
    expect(
      existsSync(ciPath),
      `expected repo-root CI workflow at ${ciPath}`,
    ).toBe(true);

    const makefile = readFileSync(makefilePath, "utf8");
    const ci = readFileSync(ciPath, "utf8");
    // The target definition `check-bundle:` (start of a make rule line).
    expect(/^check-bundle:/m.test(makefile)).toBe(true);
    expect(ci).toContain("check-bundle");
  });

  // R6 — workspaceRestore.ts is the one server-safe restore resolver: no "use client", no
  // @/lib/api import, and it is imported by BOTH the server bootstrap and the client store
  // (parity by construction — both compute identical restored state from the same module).
  it("R6: workspaceRestore.ts is server-safe and shared by the server bootstrap and the client store", () => {
    const restore = appText("src/lib/workspace/workspaceRestore.ts");
    // No "use client" DIRECTIVE — a real directive is a statement line that is just the string
    // literal (the file's own doc-comment legitimately mentions the words, so a bare substring
    // check would false-positive). The module must be importable by the server bootstrap.
    const hasUseClientDirective = restore
      .split("\n")
      .some((line) => /^\s*["']use client["'];?\s*$/.test(line));
    expect(hasUseClientDirective).toBe(false);
    // No transport dependency: nothing imported from @/lib/api/*.
    expect(/from\s+["']@\/lib\/api/.test(restore)).toBe(false);
    // Symmetric to the "use client" check: no `import "server-only"` either, so the module stays
    // importable by the CLIENT store. The isomorphic invariant is two-sided — neither a
    // client-only directive nor a server-only marker may creep in.
    expect(/import\s+["']server-only["']/.test(restore)).toBe(false);

    expect(appText("src/lib/workspace/bootstrap.server.ts")).toContain(
      "workspace/workspaceRestore",
    );
    expect(appText("src/lib/workspace/store.tsx")).toContain(
      "workspace/workspaceRestore",
    );
  });
});

// Recursively list .ts/.tsx source files (excluding tests) under a dir, returned as paths
// relative to APP_ROOT — same traversal shape as the existing source-gate tests.
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
