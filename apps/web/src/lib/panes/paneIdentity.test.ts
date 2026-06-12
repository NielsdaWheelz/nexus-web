import { describe, expect, it } from "vitest";
import {
  hasSamePaneResource,
  resolvePaneRouteIdentity,
} from "@/lib/panes/paneIdentity";

const MEDIA_ID_1 = "11111111-1111-4111-8111-111111111111";
const MEDIA_ID_2 = "22222222-2222-4222-8222-222222222222";
const LIBRARY_ID_1 = "33333333-3333-4333-8333-333333333333";
const LIBRARY_ID_2 = "44444444-4444-4444-8444-444444444444";

describe("pane route identity", () => {
  it("keeps media resource identity stable across reader location state", () => {
    const base = resolvePaneRouteIdentity(`/media/${MEDIA_ID_1}`);
    const section = resolvePaneRouteIdentity(`/media/${MEDIA_ID_1}?loc=chapter-2`);
    const highlight = resolvePaneRouteIdentity(
      `/media/${MEDIA_ID_1}?highlight=h1#reader`,
    );

    expect(section.resourceKey).toBe(base.resourceKey);
    expect(highlight.resourceKey).toBe(base.resourceKey);
    expect(
      hasSamePaneResource(`/media/${MEDIA_ID_1}`, `/media/${MEDIA_ID_1}?loc=chapter-2`),
    ).toBe(true);
  });

  it("separates different media resources", () => {
    expect(
      hasSamePaneResource(`/media/${MEDIA_ID_1}?loc=a`, `/media/${MEDIA_ID_2}?loc=a`),
    ).toBe(false);
  });

  it("uses route resource refs for dynamic routes", () => {
    expect(resolvePaneRouteIdentity(`/libraries/${LIBRARY_ID_1}?tab=items`).resourceKey).toBe(
      `library:library:${LIBRARY_ID_1}`,
    );
    expect(
      hasSamePaneResource(
        `/libraries/${LIBRARY_ID_1}?tab=items`,
        `/libraries/${LIBRARY_ID_1}?tab=intelligence`,
      ),
    ).toBe(true);
    expect(
      hasSamePaneResource(`/libraries/${LIBRARY_ID_1}`, `/libraries/${LIBRARY_ID_2}`),
    ).toBe(false);
  });

  it("falls back to normalized href for routes without resource refs", () => {
    expect(resolvePaneRouteIdentity("/libraries").resourceKey).toBe(
      "libraries:/libraries",
    );
    expect(hasSamePaneResource("/libraries", "/libraries?filter=recent")).toBe(false);
  });
});
