import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Residue gate for the Library placement seam. The hard cutover
// (docs/cutovers/library-all-and-smart-views-hard-cutover.md, "Mutation
// Composition -> Library placement") requires that every definitive browser
// placement writer publishes `publishLibraryPlacementChange` at its lowest
// authoritative command helper. This test enumerates all direct placement HTTP
// writers so a FUTURE direct writer that forgets to publish is caught here.

const APP_ROOT = process.cwd();
const SRC = join(APP_ROOT, "src");
const PUBLISH = "publishLibraryPlacementChange";

// (a) The known modules that own a direct placement write must each publish.
const KNOWN_WRITER_MODULES = [
  "src/lib/libraries/libraryPlacement.ts",
  "src/lib/media/ingestionClient.ts",
  "src/lib/media/mediaLibraries.ts",
  "src/lib/podcasts/opmlImport.ts",
  "src/lib/libraries/governance.ts",
  "src/app/(authenticated)/podcasts/podcastSubscriptions.ts",
  "src/app/(authenticated)/libraries/LibrariesPaneBody.tsx",
  "src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx",
] as const;

// (b) Direct placement-write endpoint literals. Reads (GET with `?query`) and
// non-placement sub-paths deliberately do not match; each pattern targets a
// definitive placement write.
const WRITE_ENDPOINT_PATTERNS: readonly RegExp[] = [
  /media\/\$\{[^}]+\}\/libraries/, // POST add media to libraries
  /libraries\/\$\{[^}]+\}\/podcasts/, // subscribe a podcast into a library
  /podcasts\/subscriptions["'`]/, // POST subscribe (bare endpoint only)
  /podcasts\/import\/opml/, // OPML import placement
  /invites\/\$\{[^}]+\}\/accept/, // accept a library invitation
  /media\/from-url/, // create owned media from a URL
  /media\/upload\/init/, // create owned media by upload
];

// Files that legitimately reach a write endpoint yet delegate the publish to a
// lower helper. Every entry names the publisher it defers to. The store owner
// and the BFF proxy routes are excluded from the scan entirely.
const DELEGATED_WRITERS: Readonly<Record<string, string>> = {
  // Add Content / quick capture / note + connection attach all funnel media
  // creation through the ingestionClient helpers, which publish once per
  // acknowledged create; callers never re-issue the URL literal.
  // (none of these currently inline a write URL literal — listed for the day
  // one does, so the reviewer keeps the publish at the ingestionClient helper.)
  "src/lib/nexus/dispatch.ts": "@/lib/media/ingestionClient",
  "src/components/notes/NoteBodyEditor.tsx": "@/lib/media/ingestionClient",
  "src/components/connections/ConnectionsSurface.tsx":
    "@/lib/media/ingestionClient",
  "src/components/nexus/useAddContentSession.ts": "@/lib/media/ingestionClient",
};

const EXCLUDED_PATHS = new Set([
  // The two files that own the placement store; excluded so the store itself is
  // never mistaken for a writer.
  "src/lib/libraries/placementRevision.ts",
  "src/lib/libraries/placementRevision.test.ts",
]);

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      const rel = relative(APP_ROOT, path).split(sep).join("/");
      if (entry.isDirectory()) {
        // Skip the BFF proxy routes: they are the server-side pass-through and
        // never own the browser placement seam.
        if (rel === "src/app/api") return [];
        return sourceFiles(path);
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name))
        return [];
      return [rel];
    })
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(APP_ROOT, rel), "utf8");
}

describe("library placement residue", () => {
  it("every known placement-writer module publishes the revision", () => {
    const missing = KNOWN_WRITER_MODULES.filter(
      (rel) => !read(rel).includes(PUBLISH),
    );
    expect(missing).toEqual([]);
  });

  it("every file that reaches a placement-write endpoint publishes or delegates", () => {
    const offenders = sourceFiles(SRC)
      .filter((rel) => !EXCLUDED_PATHS.has(rel))
      .filter((rel) => {
        const text = read(rel);
        return WRITE_ENDPOINT_PATTERNS.some((pattern) => pattern.test(text));
      })
      .filter(
        (rel) =>
          !read(rel).includes(PUBLISH) && DELEGATED_WRITERS[rel] === undefined,
      );
    expect(offenders).toEqual([]);
  });
});
