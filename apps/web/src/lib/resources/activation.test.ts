import { afterEach, describe, expect, it, vi } from "vitest";
import { activateResource, type ResourceActivation } from "./activation";

const route: ResourceActivation = {
  resourceRef: "media:11111111-1111-4111-8111-111111111111",
  kind: "route",
  href: "/media/11111111-1111-4111-8111-111111111111",
  unresolvedReason: null,
};

describe("activateResource", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls through to navigation when a new pane was requested but unavailable", () => {
    const navigate = vi.fn();

    expect(activateResource(route, { navigate, newPane: true })).toBe(true);

    expect(navigate).toHaveBeenCalledWith(route.href);
  });

  it("owns external browser activation", () => {
    const assign = vi.fn();
    const open = vi.fn();
    vi.stubGlobal("window", { location: { assign }, open });

    expect(
      activateResource(
        {
          resourceRef: "external_snapshot:11111111-1111-4111-8111-111111111111",
          kind: "external",
          href: "https://example.test/source",
          unresolvedReason: null,
        },
        { navigate: vi.fn() },
      ),
    ).toBe(true);

    expect(assign).toHaveBeenCalledWith("https://example.test/source");
    expect(open).not.toHaveBeenCalled();
  });
});
