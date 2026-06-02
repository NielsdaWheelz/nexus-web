import { describe, expect, it } from "vitest";
import { resolveActiveDestinationId } from "./navActive";
import { NAV_MODEL } from "./navModel";

/** Mirror how the app calls the resolver: dynamic pins first, then sections. */
function resolve(
  pathname: string,
  pins: { id: string; href: string }[] = [],
): string | null {
  return resolveActiveDestinationId(pathname, [...pins, ...NAV_MODEL]);
}

describe("resolveActiveDestinationId", () => {
  it("matches libraries by exact and by prefix", () => {
    expect(resolve("/libraries")).toBe("libraries");
    expect(resolve("/libraries/123")).toBe("libraries");
  });

  it("matches browse exactly but not by prefix (no prefix declared)", () => {
    expect(resolve("/browse")).toBe("browse");
    expect(resolve("/browse/x")).toBeNull();
  });

  it("matches podcasts by prefix and exact", () => {
    expect(resolve("/podcasts/abc")).toBe("podcasts");
    expect(resolve("/podcasts")).toBe("podcasts");
  });

  it("lets notes claim /notes/ and /pages/ by prefix", () => {
    expect(resolve("/notes/123")).toBe("notes");
    expect(resolve("/pages/x")).toBe("notes");
  });

  it("lets an exact pin outrank the notes /pages/ prefix", () => {
    const pins = [{ id: "pin-1", href: "/pages/x" }];
    expect(resolve("/pages/x", pins)).toBe("pin-1");
    expect(resolve("/pages/y", pins)).toBe("notes");
  });

  it("matches chats, oracle, and today by prefix", () => {
    expect(resolve("/conversations/9")).toBe("chats");
    expect(resolve("/oracle/abc")).toBe("oracle");
    expect(resolve("/daily/2026-06-01")).toBe("today");
  });

  it("matches settings by prefix and exact", () => {
    expect(resolve("/settings/keys")).toBe("settings");
    expect(resolve("/settings")).toBe("settings");
  });

  it("returns null when nothing matches", () => {
    expect(resolve("/unknown")).toBeNull();
  });
});
