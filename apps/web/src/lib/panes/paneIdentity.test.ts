import { describe, expect, it } from "vitest";
import {
  hasSamePaneRoute,
  hasSamePaneResource,
  resolvePaneRouteIdentity,
  resolveWorkspaceActivationRouteId,
} from "@/lib/panes/paneIdentity";

const MEDIA_ID_1 = "11111111-1111-4111-8111-111111111111";
const MEDIA_ID_2 = "22222222-2222-4222-8222-222222222222";
const LIBRARY_ID_1 = "33333333-3333-4333-8333-333333333333";
const LIBRARY_ID_2 = "44444444-4444-4444-8444-444444444444";
const ARTIFACT_REF = "artifact:55555555-5555-4555-8555-555555555555";

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

  it("dedupes Artifact revision queries to one owning pane", () => {
    const current = `/artifacts/${encodeURIComponent(ARTIFACT_REF)}`;
    const historical =
      `${current}?revision=${encodeURIComponent("artifact_revision:66666666-6666-4666-8666-666666666666")}`;
    expect(hasSamePaneResource(current, historical)).toBe(true);
    expect(resolveWorkspaceActivationRouteId(current)).toBe(
      resolveWorkspaceActivationRouteId(historical),
    );
    expect(resolvePaneRouteIdentity(historical).resourceLocator).toEqual({
      kind: "resource_ref",
      ref: ARTIFACT_REF,
    });
  });

  it("uses typed resource locators for dynamic resource routes", () => {
    expect(
      resolvePaneRouteIdentity(`/libraries/${LIBRARY_ID_1}?tab=items`).resourceLocator,
    ).toEqual({
      kind: "resource_ref",
      ref: `library:${LIBRARY_ID_1}`,
    });
    const items = resolvePaneRouteIdentity(`/libraries/${LIBRARY_ID_1}?view=items`);
    const filtered = resolvePaneRouteIdentity(
      `/libraries/${LIBRARY_ID_1}?filter=recent`,
    );
    const other = resolvePaneRouteIdentity(`/libraries/${LIBRARY_ID_2}`);
    expect(items.resourceLocator).toEqual(filtered.resourceLocator);
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

  it("keeps Stats URL state in pane identity", () => {
    expect(resolvePaneRouteIdentity("/stats?period=day").routeKey).toBe(
      "stats:/stats?period=day",
    );
    expect(
      hasSamePaneRoute("/stats?period=day", "/stats?period=month"),
    ).toBe(false);
  });

  it("represents author aliases as contributor locators", () => {
    expect(resolvePaneRouteIdentity("/authors/ursula-k-le-guin").resourceLocator).toEqual({
      kind: "contributor_handle",
      handle: "ursula-k-le-guin",
    });
  });

  it("derives locator-independent activation identities for owning resources", () => {
    expect(
      resolveWorkspaceActivationRouteId(`/media/${MEDIA_ID_1}`),
    ).toBe(
      resolveWorkspaceActivationRouteId(
        `/media/${MEDIA_ID_1}?loc=chapter-2#highlight-h1`,
      ),
    );
    expect(
      resolveWorkspaceActivationRouteId(
        `/libraries/${LIBRARY_ID_1}?filter=recent`,
      ),
    ).toBe(
      resolveWorkspaceActivationRouteId(
        `/libraries/${LIBRARY_ID_1}?view=items`,
      ),
    );
    expect(
      resolveWorkspaceActivationRouteId(`/media/${MEDIA_ID_1}`),
    ).not.toBe(resolveWorkspaceActivationRouteId(`/media/${MEDIA_ID_2}`));
  });

  it("retains route-owned query state for non-resource activation identities", () => {
    expect(resolveWorkspaceActivationRouteId("/stats?period=day")).not.toBe(
      resolveWorkspaceActivationRouteId("/stats?period=month"),
    );
    expect(resolveWorkspaceActivationRouteId("/stats?period=day#detail")).toBe(
      resolveWorkspaceActivationRouteId("/stats?period=day"),
    );
  });
});
