import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./AuthenticatedShell.tsx", import.meta.url),
  "utf8",
);

describe("AuthenticatedShell player ownership", () => {
  it("mounts one player provider above every shell player consumer", () => {
    expect(source.match(/<GlobalPlayerProvider\b/g)).toHaveLength(1);
    expect(source.match(/<\/GlobalPlayerProvider>/g)).toHaveLength(1);

    const providerStart = source.indexOf("<GlobalPlayerProvider");
    const providerEnd = source.indexOf("</GlobalPlayerProvider>");
    for (const child of ["<Nexus />", "<AppNav />", "<WorkspaceHost />", "<GlobalPlayerSurfaces />"]) {
      const childIndex = source.indexOf(child);
      expect(childIndex).toBeGreaterThan(providerStart);
      expect(childIndex).toBeLessThan(providerEnd);
    }
  });
});
