const cases = [
  {
    filename: "vitest.browser-setup.ts",
    source: `
      import { vi } from "vitest";
      vi.mock("@/lib/owned", () => ({}));
    `,
    expected: "Do not mock Nexus modules",
  },
  {
    filename: "src/policy-fixture.unit.test.tsx",
    source: `
      import { expect, test, vi } from "vitest";
      vi.mock("@/lib/owned", () => ({}));
      test("owned mock", () => expect(true).toBe(true));
    `,
    expected: "Do not mock Nexus modules",
  },
  {
    filename: "e2e/journeys/policy-fixture.journey.spec.ts",
    source: `
      import { expect, test } from "@playwright/test";
      test("sleep", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        expect(true).toBe(true);
      });
    `,
    expected: "Do not sleep in tests",
  },
  {
    filename: "e2e/journeys/raw-request-import.journey.spec.ts",
    source: `
      import { request, test } from "playwright/test";
      test("raw request factory", async () => {
        const client = await request.newContext();
        await client.dispose();
      });
    `,
    expected: "Raw Playwright API requests belong only to e2e/request.ts",
  },
  {
    filename: "e2e/journeys/page-request.journey.spec.ts",
    source: `
      import { test } from "playwright/test";
      test("page request", async ({ page }) => {
        await page.request.get("/api/me");
      });
    `,
    expected: "Do not use page.request or context.request",
  },
  {
    filename: "e2e/extension/context-request.extension.spec.ts",
    source: `
      import { test } from "playwright/test";
      test("context request", async ({ context }) => {
        await context.request.get("/api/me");
      });
    `,
    expected: "Do not use page.request or context.request",
  },
  {
    filename: "e2e/deployment/request-fixture.deployed.spec.ts",
    source: `
      import { test } from "playwright/test";
      test("raw request fixture", async ({ request }) => {
        await request.get("/api/me");
      });
    `,
    expected: "Do not use Playwright's raw request fixture",
  },
  {
    filename: "src/vacuous.unit.test.ts",
    source: `
      import { test } from "vitest";
      test("empty", () => {});
    `,
    expected: "A test callback must execute an observable proof",
  },
  {
    filename: "e2e/journeys/vacuous.journey.spec.ts",
    source: `
      import { expect, test } from "@playwright/test";
      test("literal", async () => {
        expect(true).toBe(true);
      });
    `,
    expected: "Do not assert a literal",
  },
  {
    filename: "src/template-mock.unit.test.tsx",
    source: `
      import { expect, test, vi } from "vitest";
      vi.mock(\`@/lib/owned\`, () => ({}));
      test("template mock", () => expect(true).toBe(true));
    `,
    expected: "Do not mock Nexus modules",
  },
  {
    filename: "src/spy-on.unit.test.tsx",
    source: `
      import { expect, test, vi } from "vitest";
      vi.spyOn(globalThis, "fetch");
      test("spy", () => expect(true).toBe(true));
    `,
    expected: "Do not spy on owned behavior",
  },
  {
    filename: "src/fake-timers.unit.test.tsx",
    source: `
      import { expect, test, vi } from "vitest";
      vi.useFakeTimers();
      test("timers", () => expect(true).toBe(true));
    `,
    expected: "Do not use fake timers",
  },
  {
    filename: "src/disabled-test.unit.test.tsx",
    source: `
      import { expect, test } from "vitest";
      test.skip("skipped", () => expect(true).toBe(true));
    `,
    expected: "Tests must run exactly as collected",
  },
  {
    filename: "e2e/journeys/route-intercept.journey.spec.ts",
    source: `
      import { expect, test } from "@playwright/test";
      test("route", async ({ page }) => {
        await page.route("**/*", (route) => route.fulfill({ status: 200 }));
        expect(true).toBe(true);
      });
    `,
    expected: "Journey files cannot intercept routes",
  },
  // AC12 residue: every retired resource-action symbol re-introduced anywhere in
  // product source must fail lint (docs/cutovers/canonical-resource-action-menu-hard-cutover.md).
  {
    filename: "src/residue-composeResourceMenu.ts",
    source: `export const composeResourceMenu = null;\n`,
    expected: "Retired resource-action symbol",
  },
  {
    filename: "src/residue-ResourceMenuGroups.ts",
    source: `export const ResourceMenuGroups = null;\n`,
    expected: "Retired resource-action symbol",
  },
  {
    filename: "src/residue-emptyResourceMenuGroups.ts",
    source: `export const emptyResourceMenuGroups = null;\n`,
    expected: "Retired resource-action symbol",
  },
  {
    filename: "src/residue-RichResourceActionGroups.ts",
    source: `export const RichResourceActionGroups = null;\n`,
    expected: "Retired resource-action symbol",
  },
  {
    filename: "src/residue-ActionPublication.ts",
    source: `export const ActionPublication = null;\n`,
    expected: "Retired resource-action symbol",
  },
  {
    filename: "src/residue-publishResourceRowActions.ts",
    source: `export const publishResourceRowActions = null;\n`,
    expected: "Retired resource-action symbol",
  },
  {
    filename: "src/residue-resolveResourceCoreActions.ts",
    source: `export const resolveResourceCoreActions = null;\n`,
    expected: "Retired resource-action symbol",
  },
  {
    filename: "src/residue-resolveResourceCoreCatalogKeys.ts",
    source: `export const resolveResourceCoreCatalogKeys = null;\n`,
    expected: "Retired resource-action symbol",
  },
  {
    filename: "src/residue-resolveUniversalResourceRelationshipActions.ts",
    source: `export const resolveUniversalResourceRelationshipActions = null;\n`,
    expected: "Retired resource-action symbol",
  },
  {
    filename: "src/residue-ResourceActionProjection.ts",
    source: `export const ResourceActionProjection = null;\n`,
    expected: "Retired resource-action symbol",
  },
  {
    filename: "src/residue-buildResourceNexusActions.ts",
    source: `export const buildResourceNexusActions = null;\n`,
    expected: "Retired resource-action symbol",
  },
  {
    filename: "src/residue-mediaResourceOptions.ts",
    source: `export const mediaResourceOptions = null;\n`,
    expected: "Retired resource-action symbol",
  },
  {
    filename: "src/residue-episodeResourceOptions.ts",
    source: `export const episodeResourceOptions = null;\n`,
    expected: "Retired resource-action symbol",
  },
  {
    filename: "src/residue-libraryResourceOptions.ts",
    source: `export const libraryResourceOptions = null;\n`,
    expected: "Retired resource-action symbol",
  },
  {
    filename: "src/residue-podcastResourceOptions.ts",
    source: `export const podcastResourceOptions = null;\n`,
    expected: "Retired resource-action symbol",
  },
  {
    filename: "src/residue-conversationResourceOptions.ts",
    source: `export const conversationResourceOptions = null;\n`,
    expected: "Retired resource-action symbol",
  },
  // AC12 residue: retired player/queue string-literal ids and their template
  // escape variant must fail lint.
  {
    filename: "src/residue-id-queue-add.ts",
    source: `export const id = "queue-add";\n`,
    expected: "queue-add and the player-local",
  },
  {
    filename: "src/residue-id-player-open-track.ts",
    source: `export const id = "Player.OpenTrack";\n`,
    expected: "queue-add and the player-local",
  },
  {
    filename: "src/residue-id-player-open-source.ts",
    source: `export const id = "Player.OpenSource";\n`,
    expected: "queue-add and the player-local",
  },
  {
    filename: "src/residue-id-queue-add-template.ts",
    source: "export const id = `queue-add`;\n",
    expected: "queue-add and the player-local",
  },
  // AC12 residue: retired context-edge/connection ids belong to ContextEdgeMenu,
  // not the resource menu — literal and template forms must fail lint.
  {
    filename: "src/residue-id-context-remove.ts",
    source: `export const id = "RelationshipAction.Context.Remove";\n`,
    expected: "publish through the separate ContextEdgeMenu contract",
  },
  {
    filename: "src/residue-id-connection-unlink.ts",
    source: `export const id = "RelationshipAction.Connection.Unlink";\n`,
    expected: "publish through the separate ContextEdgeMenu contract",
  },
  {
    filename: "src/residue-id-connection-dismiss.ts",
    source: `export const id = "RelationshipAction.Connection.Dismiss";\n`,
    expected: "publish through the separate ContextEdgeMenu contract",
  },
  {
    filename: "src/residue-id-context-remove-template.ts",
    source: "export const id = `RelationshipAction.Context.Remove`;\n",
    expected: "publish through the separate ContextEdgeMenu contract",
  },
  // Canonical-resource-action hard cut: old cache invalidation, duplicate
  // projections, surface-local executors/busy stores, and neighboring resource
  // action builders must be impossible to reintroduce.
  {
    filename: "src/residue-useResourceActionCatalogProjection.ts",
    source: `export const useResourceActionCatalogProjection = null;\n`,
    expected: "Retired canonical resource-action path",
  },
  {
    filename: "src/residue-publishResourceActionSnapshotInvalidation.ts",
    source: `export const publishResourceActionSnapshotInvalidation = null;\n`,
    expected: "Retired canonical resource-action path",
  },
  {
    filename: "src/residue-useDocumentActions.ts",
    source: `export const useDocumentActions = null;\n`,
    expected: "Retired canonical resource-action path",
  },
  {
    filename: "src/residue-episodeActionBusyKey.ts",
    source: `export const episodeActionBusyKey = null;\n`,
    expected: "Retired canonical resource-action path",
  },
  {
    filename: "src/residue-buildHighlightActions.ts",
    source: `export const buildHighlightActions = null;\n`,
    expected: "Retired canonical resource-action path",
  },
  {
    filename: "src/residue-id-episode-play-next.ts",
    source: `export const id = "ViewAction.Episode.PlayNext";\n`,
    expected: "Retired surface-local resource-action id",
  },
  {
    filename: "src/residue-id-episode-transcript.ts",
    source: `export const id = "ViewAction.Episode.Transcript";\n`,
    expected: "Retired surface-local resource-action id",
  },
  {
    filename: "src/residue-id-author-rename.ts",
    source: `export const id = "Author.Rename";\n`,
    expected: "Retired surface-local resource-action id",
  },
  {
    filename: "src/residue-id-player-open-preview.ts",
    source: `export const id = "Player.OpenPreview";\n`,
    expected: "Retired surface-local resource-action id",
  },
  {
    filename: "src/residue-id-player-preview-source.ts",
    source: `export const id = "Player.PreviewSource";\n`,
    expected: "Retired surface-local resource-action id",
  },
  {
    filename: "src/residue-resource-action-menu-target.tsx",
    source: `const menu = <ResourceActionMenu target={subject} />;\n`,
    expected: "ResourceActionMenu accepts actionSubject",
  },
];

for (const fixture of cases) {
  const result = Bun.spawnSync(
    [
      "bun",
      "run",
      "eslint",
      "--stdin",
      "--stdin-filename",
      fixture.filename,
      "--max-warnings",
      "0",
    ],
    { cwd: import.meta.dir + "/..", stdin: new Blob([fixture.source]) },
  );
  const diagnostic = result.stdout.toString() + result.stderr.toString();
  if (result.exitCode === 0 || !diagnostic.includes(fixture.expected)) {
    throw new Error(
      `ESLint policy fixture did not fail for ${fixture.filename}: ${diagnostic}`,
    );
  }
}

console.log(`eslint-policy: ${cases.length} adversarial fixtures rejected`);

// The architectural hard-cut proof is deliberately part of the stable policy
// gate: its hand-authored surface ledger must stay exhaustive as the product
// oracle evolves, and retired local action islands may never return.
await import("./test-resource-action-surface-policy.mjs");
