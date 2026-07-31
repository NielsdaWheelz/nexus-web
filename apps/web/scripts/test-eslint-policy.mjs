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
