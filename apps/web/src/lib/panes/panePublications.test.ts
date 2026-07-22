import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  arePaneFixedChromePublicationsEqual,
  arePanePrimaryChromePublicationsEqual,
  arePaneSecondaryPublicationsEqual,
  getPublishedSecondarySurface,
  normalizePaneFixedChromePublication,
  normalizePaneSecondaryPublication,
  secondaryPublicationIncludesSurface,
  type PaneSecondaryPublication,
  type PanePrimaryChromePublication,
} from "@/lib/panes/panePublications";

describe("panePublications", () => {
  it("compares primary chrome structurally except for React and callback identities", () => {
    const icon = createElement("span");
    const toolbar = createElement("div");
    const onSelect = () => {};
    const publication: PanePrimaryChromePublication = {
      header: {
        kind: "resource",
        resource: {
          status: "ready",
          title: "Dune",
          creditGroups: [{
            kind: "authors",
            credits: [{ label: "Frank Herbert", href: "/authors/frank-herbert" }],
          }],
        },
      },
      toolbar,
      actions: [{
        kind: "command",
        id: "map",
        label: "Document Map",
        icon,
        state: {
          kind: "disclosure",
          expanded: true,
          controls: "map-region",
          menuLabels: { collapsed: "Show map", expanded: "Hide map" },
        },
        onSelect,
      }],
      options: [{
        kind: "command",
        id: "credits",
        label: "Credits…",
        onSelect,
      }],
    };

    expect(arePanePrimaryChromePublicationsEqual(publication, {
      ...publication,
      header: {
        kind: "resource",
        resource: {
          status: "ready",
          title: "Dune",
          creditGroups: [{
            kind: "authors",
            credits: [{ label: "Frank Herbert", href: "/authors/frank-herbert" }],
          }],
        },
      },
      actions: publication.actions ? [...publication.actions] : undefined,
      options: publication.options ? [...publication.options] : undefined,
    })).toBe(true);
    expect(arePanePrimaryChromePublicationsEqual(publication, {
      ...publication,
      toolbar: createElement("div"),
    })).toBe(false);
    expect(arePanePrimaryChromePublicationsEqual(publication, {
      ...publication,
      actions: [{ ...publication.actions![0]!, icon: createElement("span") }],
    })).toBe(false);
    expect(arePanePrimaryChromePublicationsEqual(publication, {
      ...publication,
      options: [{
        kind: "command",
        id: "credits",
        label: "Credits…",
        onSelect: () => {},
      }],
    })).toBe(false);
  });

  it("normalizes and clones valid secondary publications", () => {
    const body = createElement("div");
    const surface = { id: "reader-evidence" as const, body };
    const publication: PaneSecondaryPublication = {
      groupId: "reader-tools",
      defaultSurfaceId: "reader-evidence",
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
        defaultSurfaceId: "reader-evidence",
        surfaces: [],
      }),
    ).toThrow("at least one surface");
    expect(() =>
      normalizePaneSecondaryPublication({
        groupId: "reader-tools",
        defaultSurfaceId: "reader-evidence",
        surfaces: [
          { id: "reader-evidence", body },
          { id: "reader-evidence", body },
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
        defaultSurfaceId: "reader-contents",
        surfaces: [{ id: "reader-evidence", body }],
      }),
    ).toThrow("is not published");
  });

  it("compares secondary publications by ordered surface ids and body identity", () => {
    const body = createElement("div");
    const otherBody = createElement("div");
    const publication: PaneSecondaryPublication = {
      groupId: "reader-tools",
      defaultSurfaceId: "reader-evidence",
      surfaces: [
        { id: "reader-contents", body },
        { id: "reader-evidence", body },
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
          { id: "reader-evidence", body },
          { id: "reader-contents", body },
        ],
      }),
    ).toBe(false);
    expect(
      arePaneSecondaryPublicationsEqual(publication, {
        ...publication,
        surfaces: [
          { id: "reader-contents", body: otherBody },
          { id: "reader-evidence", body },
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
        defaultSurfaceId: "reader-contents",
      }),
    ).toBe(false);
    expect(
      arePaneSecondaryPublicationsEqual(publication, {
        ...publication,
        surfaces: [{ id: "reader-evidence", body }],
      }),
    ).toBe(false);
    expect(
      arePaneSecondaryPublicationsEqual(publication, {
        ...publication,
        surfaces: [
          { id: "reader-contents", body },
          { id: "reader-evidence", body: otherBody },
        ],
      }),
    ).toBe(false);
  });

  it("finds published secondary surfaces", () => {
    const body = createElement("div");
    const publication: PaneSecondaryPublication = {
      groupId: "reader-tools",
      defaultSurfaceId: "reader-evidence",
      surfaces: [{ id: "reader-evidence", body }],
    };

    expect(getPublishedSecondarySurface(publication, "reader-evidence")).toEqual({
      id: "reader-evidence",
      body,
    });
    expect(getPublishedSecondarySurface(null, "reader-evidence")).toBeNull();
    expect(getPublishedSecondarySurface(publication, null)).toBeNull();
    expect(getPublishedSecondarySurface(publication, undefined)).toBeNull();
    expect(getPublishedSecondarySurface(publication, "reader-contents")).toBeNull();
    expect(secondaryPublicationIncludesSurface(publication, "reader-evidence")).toBe(true);
    expect(secondaryPublicationIncludesSurface(null, "reader-evidence")).toBe(false);
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

  it("compares raw fixed chrome publications without validating before the route gate", () => {
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
    ).toBe(false);
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
    expect(
      arePaneFixedChromePublicationsEqual(
        { id: "reader-document-map-overview-rail", widthPx: Number.NaN, body },
        { id: "reader-document-map-overview-rail", widthPx: Number.NaN, body },
      ),
    ).toBe(false);
    const invalidPublication = {
      id: "reader-document-map-overview-rail" as const,
      widthPx: Number.NaN,
      body,
    };
    expect(
      arePaneFixedChromePublicationsEqual(invalidPublication, invalidPublication),
    ).toBe(true);
  });
});
