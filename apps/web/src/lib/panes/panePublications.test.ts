import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  arePaneFixedChromePublicationsEqual,
  arePaneSecondaryPublicationsEqual,
  getPublishedSecondarySurface,
  normalizePaneFixedChromePublication,
  normalizePaneSecondaryPublication,
  secondaryPublicationIncludesSurface,
  type PaneSecondaryPublication,
} from "@/lib/panes/panePublications";

describe("panePublications", () => {
  it("normalizes and clones valid secondary publications", () => {
    const body = createElement("div");
    const surface = { id: "reader-highlights" as const, body };
    const publication: PaneSecondaryPublication = {
      groupId: "reader-tools",
      defaultSurfaceId: "reader-highlights",
      surfaces: [surface],
    };

    const normalized = normalizePaneSecondaryPublication(publication);

    expect(normalized).toEqual(publication);
    expect(normalized.surfaces).not.toBe(publication.surfaces);
    expect(normalized.surfaces[0]).not.toBe(surface);
  });

  it("rejects invalid secondary publications", () => {
    const body = createElement("div");

    expect(() =>
      normalizePaneSecondaryPublication({
        groupId: "reader-tools",
        defaultSurfaceId: "reader-highlights",
        surfaces: [],
      }),
    ).toThrow("at least one surface");
    expect(() =>
      normalizePaneSecondaryPublication({
        groupId: "reader-tools",
        defaultSurfaceId: "reader-highlights",
        surfaces: [
          { id: "reader-highlights", body },
          { id: "reader-highlights", body },
        ],
      }),
    ).toThrow("Duplicate secondary surface publication");
    expect(() =>
      normalizePaneSecondaryPublication({
        groupId: "reader-tools",
        defaultSurfaceId: "conversation-context-refs",
        surfaces: [{ id: "conversation-context-refs", body }],
      }),
    ).toThrow("does not belong to group");
    expect(() =>
      normalizePaneSecondaryPublication({
        groupId: "reader-tools",
        defaultSurfaceId: "reader-resource-chat",
        surfaces: [{ id: "reader-highlights", body }],
      }),
    ).toThrow("is not published");
  });

  it("compares secondary publications by ordered surface ids and body identity", () => {
    const body = createElement("div");
    const otherBody = createElement("div");
    const publication: PaneSecondaryPublication = {
      groupId: "reader-tools",
      defaultSurfaceId: "reader-highlights",
      surfaces: [
        { id: "reader-highlights", body },
        { id: "reader-resource-chat", body },
      ],
    };

    expect(arePaneSecondaryPublicationsEqual(null, null)).toBe(true);
    expect(arePaneSecondaryPublicationsEqual(publication, null)).toBe(false);
    expect(arePaneSecondaryPublicationsEqual(publication, publication)).toBe(true);
    expect(
      arePaneSecondaryPublicationsEqual(publication, {
        ...publication,
        surfaces: [...publication.surfaces],
      }),
    ).toBe(true);
    expect(
      arePaneSecondaryPublicationsEqual(publication, {
        ...publication,
        surfaces: [
          { id: "reader-resource-chat", body },
          { id: "reader-highlights", body },
        ],
      }),
    ).toBe(false);
    expect(
      arePaneSecondaryPublicationsEqual(publication, {
        ...publication,
        surfaces: [
          { id: "reader-highlights", body: otherBody },
          { id: "reader-resource-chat", body },
        ],
      }),
    ).toBe(false);
    expect(
      arePaneSecondaryPublicationsEqual(publication, {
        groupId: "conversation-context",
        defaultSurfaceId: "conversation-context-refs",
        surfaces: [{ id: "conversation-context-refs", body }],
      }),
    ).toBe(false);
    expect(
      arePaneSecondaryPublicationsEqual(publication, {
        ...publication,
        defaultSurfaceId: "reader-resource-chat",
      }),
    ).toBe(false);
    expect(
      arePaneSecondaryPublicationsEqual(publication, {
        ...publication,
        surfaces: [{ id: "reader-highlights", body }],
      }),
    ).toBe(false);
    expect(
      arePaneSecondaryPublicationsEqual(publication, {
        ...publication,
        surfaces: [
          { id: "reader-highlights", body },
          { id: "reader-apparatus", body },
        ],
      }),
    ).toBe(false);
  });

  it("finds published secondary surfaces", () => {
    const body = createElement("div");
    const publication: PaneSecondaryPublication = {
      groupId: "reader-tools",
      defaultSurfaceId: "reader-highlights",
      surfaces: [{ id: "reader-highlights", body }],
    };

    expect(getPublishedSecondarySurface(publication, "reader-highlights")).toEqual({
      id: "reader-highlights",
      body,
    });
    expect(getPublishedSecondarySurface(null, "reader-highlights")).toBeNull();
    expect(getPublishedSecondarySurface(publication, null)).toBeNull();
    expect(getPublishedSecondarySurface(publication, undefined)).toBeNull();
    expect(getPublishedSecondarySurface(publication, "reader-resource-chat")).toBeNull();
    expect(secondaryPublicationIncludesSurface(publication, "reader-highlights")).toBe(true);
    expect(secondaryPublicationIncludesSurface(null, "reader-highlights")).toBe(false);
  });

  it("normalizes fixed chrome width", () => {
    const body = createElement("div");

    expect(
      normalizePaneFixedChromePublication({
        id: "reader-document-map-overview-rail",
        widthPx: 28.1,
        body,
      }),
    ).toEqual({
      id: "reader-document-map-overview-rail",
      widthPx: 29,
      body,
    });
    expect(
      normalizePaneFixedChromePublication({
        id: "reader-document-map-overview-rail",
        widthPx: 0,
        body,
      }),
    ).toEqual({
      id: "reader-document-map-overview-rail",
      widthPx: 0,
      body,
    });
    expect(
      normalizePaneFixedChromePublication({
        id: "reader-document-map-overview-rail",
        widthPx: 29,
        body,
      }),
    ).toEqual({
      id: "reader-document-map-overview-rail",
      widthPx: 29,
      body,
    });
    for (const widthPx of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() =>
        normalizePaneFixedChromePublication({
          id: "reader-document-map-overview-rail",
          widthPx,
          body,
        }),
      ).toThrow("non-negative");
    }
  });

  it("compares fixed chrome publications by canonical width and body identity", () => {
    const body = createElement("div");

    expect(arePaneFixedChromePublicationsEqual(null, null)).toBe(true);
    expect(
      arePaneFixedChromePublicationsEqual(
        { id: "reader-document-map-overview-rail", widthPx: 28, body },
        null,
      ),
    ).toBe(false);
    expect(
      arePaneFixedChromePublicationsEqual(
        { id: "reader-document-map-overview-rail", widthPx: 28.1, body },
        { id: "reader-document-map-overview-rail", widthPx: 29, body },
      ),
    ).toBe(true);
    expect(
      arePaneFixedChromePublicationsEqual(
        { id: "reader-document-map-overview-rail", widthPx: 28, body },
        { id: "reader-document-map-overview-rail", widthPx: 28, body: createElement("div") },
      ),
    ).toBe(false);
    expect(
      arePaneFixedChromePublicationsEqual(
        { id: "reader-document-map-overview-rail", widthPx: 28, body },
        { id: "reader-document-map-overview-rail", widthPx: 29, body },
      ),
    ).toBe(false);
    expect(() =>
      arePaneFixedChromePublicationsEqual(
        { id: "reader-document-map-overview-rail", widthPx: Number.NaN, body },
        { id: "reader-document-map-overview-rail", widthPx: Number.NaN, body },
      ),
    ).toThrow("non-negative");
    const invalidPublication = {
      id: "reader-document-map-overview-rail" as const,
      widthPx: Number.NaN,
      body,
    };
    expect(() =>
      arePaneFixedChromePublicationsEqual(invalidPublication, invalidPublication),
    ).toThrow("non-negative");
  });
});
