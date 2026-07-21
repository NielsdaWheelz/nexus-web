import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RESULT_TYPE_VALUES } from "./types";

const REPO_ROOT = join(process.cwd(), "../..");

function quotedValues(source: string, pattern: RegExp): string[] {
  const match = source.match(pattern);
  if (!match) throw new Error(`Pattern did not match: ${pattern}`);
  return Array.from(match[1].matchAll(/"([^"]+)"/g), (value) => value[1]);
}

describe("frontend search result-type vocabulary", () => {
  it("matches backend SEARCH_RESULT_TYPES (incl. artifact)", () => {
    // `RESULT_TYPE_VALUES` validates every `context_ref.type` on the wire, so it
    // must cover exactly the backend's canonical result-discriminant authority.
    // The two lists are intentionally allowed to differ in order (set parity),
    // but a missing member — e.g. `artifact` — silently drops rows client-side.
    const search = readFileSync(
      join(REPO_ROOT, "python/nexus/schemas/search.py"),
      "utf8",
    );
    const backendTypes = quotedValues(
      search,
      /SEARCH_RESULT_TYPES = Literal\[([\s\S]*?)\]/,
    );
    expect([...RESULT_TYPE_VALUES].sort()).toEqual([...backendTypes].sort());
  });
});
