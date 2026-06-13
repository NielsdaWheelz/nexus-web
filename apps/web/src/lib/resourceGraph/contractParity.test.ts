import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EDGE_KINDS, EDGE_ORIGINS } from "./edges";
import { RESOURCE_SCHEMES } from "./resourceRef";

const REPO_ROOT = join(process.cwd(), "../..");

function quotedValues(source: string, pattern: RegExp): string[] {
  const match = source.match(pattern);
  if (!match) throw new Error(`Pattern did not match: ${pattern}`);
  return Array.from(match[1].matchAll(/"([^"]+)"/g), (value) => value[1]);
}

describe("frontend resource graph vocabulary", () => {
  it("matches backend ResourceScheme, EdgeKind, and EdgeOrigin literals", () => {
    const refs = readFileSync(
      join(REPO_ROOT, "python/nexus/services/resource_graph/refs.py"),
      "utf8",
    );
    const schemas = readFileSync(
      join(REPO_ROOT, "python/nexus/services/resource_graph/schemas.py"),
      "utf8",
    );

    expect([...RESOURCE_SCHEMES]).toEqual(
      quotedValues(refs, /RESOURCE_SCHEMES:.*?=\s*\(([\s\S]*?)\)/),
    );
    expect([...EDGE_KINDS]).toEqual(
      quotedValues(schemas, /EdgeKind = Literal\[([\s\S]*?)\]/),
    );
    expect([...EDGE_ORIGINS]).toEqual(
      quotedValues(schemas, /EdgeOrigin = Literal\[([\s\S]*?)\]/),
    );
  });
});
