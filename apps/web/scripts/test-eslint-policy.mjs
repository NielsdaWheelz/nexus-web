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
