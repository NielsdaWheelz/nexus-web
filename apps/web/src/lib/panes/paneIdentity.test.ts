import { describe, expect, it } from "vitest";
import {
  hasSamePaneRoute,
  hasSamePaneResource,
  resolvePaneRouteIdentity,
} from "@/lib/panes/paneIdentity";

const MEDIA_ID_1 = "11111111-1111-4111-8111-111111111111";
const MEDIA_ID_2 = "22222222-2222-4222-8222-222222222222";
const LIBRARY_ID_1 = "33333333-3333-4333-8333-333333333333";
const LIBRARY_ID_2 = "44444444-4444-4444-8444-444444444444";

describe("pane route identity", () => {
  it("separates route keys from resource locators", () => {
    const base = resolvePaneRouteIdentity(`/media/${MEDIA_ID_1}`);
    const section = resolvePaneRouteIdentity(`/media/${MEDIA_ID_1}?loc=chapter-2`);
    const highlight = resolvePaneRouteIdentity(
      `/media/${MEDIA_ID_1}?apparatus=ap-1#highlight-h1`,
    );

    expect(base.routeKey).toBe(`media:/media/${MEDIA_ID_1}`);
    expect(section.routeKey).toBe(`media:/media/${MEDIA_ID_1}?loc=chapter-2`);
    expect(highlight.routeKey).toBe(
      `media:/media/${MEDIA_ID_1}?apparatus=ap-1`,
    );
    expect(section.resourceLocator).toEqual(base.resourceLocator);
    expect(highlight.resourceLocator).toEqual(base.resourceLocator);
    expect(hasSamePaneRoute(`/media/${MEDIA_ID_1}`, `/media/${MEDIA_ID_1}`)).toBe(
      true,
    );
    expect(
      hasSamePaneRoute(`/media/${MEDIA_ID_1}`, `/media/${MEDIA_ID_1}?loc=chapter-2`),
    ).toBe(false);
    expect(
      hasSamePaneResource(`/media/${MEDIA_ID_1}`, `/media/${MEDIA_ID_1}?loc=chapter-2`),
    ).toBe(true);
    expect(section.resourceLocator).not.toBeNull();
    expect(base.resourceLocator).toEqual(section.resourceLocator);
  });

  it("separates different media resources", () => {
    const first = resolvePaneRouteIdentity(`/media/${MEDIA_ID_1}?loc=a`);
    const second = resolvePaneRouteIdentity(`/media/${MEDIA_ID_2}?loc=a`);
    expect(first.resourceLocator).not.toEqual(second.resourceLocator);
    expect(
      hasSamePaneResource(`/media/${MEDIA_ID_1}?loc=a`, `/media/${MEDIA_ID_2}?loc=a`),
    ).toBe(false);
  });

  it("uses typed resource locators for dynamic resource routes", () => {
    expect(
      resolvePaneRouteIdentity(`/libraries/${LIBRARY_ID_1}?tab=items`).resourceLocator,
    ).toEqual({
      kind: "resource_ref",
      ref: `library:${LIBRARY_ID_1}`,
    });
    const items = resolvePaneRouteIdentity(`/libraries/${LIBRARY_ID_1}?tab=items`);
    const intelligence = resolvePaneRouteIdentity(
      `/libraries/${LIBRARY_ID_1}?tab=intelligence`,
    );
    const other = resolvePaneRouteIdentity(`/libraries/${LIBRARY_ID_2}`);
    expect(items.resourceLocator).toEqual(intelligence.resourceLocator);
    expect(items.resourceLocator).not.toEqual(other.resourceLocator);
  });

  it("keeps non-resource routes route-keyed without resource fallback", () => {
    expect(resolvePaneRouteIdentity("/libraries")).toMatchObject({
      routeKey: "libraries:/libraries",
      resourceLocator: null,
    });
    expect(hasSamePaneRoute("/libraries", "/libraries?filter=recent")).toBe(false);
    expect(hasSamePaneResource("/libraries", "/libraries?filter=recent")).toBe(false);
  });

  it("represents author aliases as contributor locators", () => {
    expect(resolvePaneRouteIdentity("/authors/ursula-k-le-guin").resourceLocator).toEqual({
      kind: "contributor_handle",
      handle: "ursula-k-le-guin",
    });
  });
});
