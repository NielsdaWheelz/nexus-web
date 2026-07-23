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
        id: "companion",
        label: "Companion",
        icon,
        state: {
          kind: "disclosure",
          expanded: true,
          controls: "companion-region",
          menuLabels: { collapsed: "Open Companion", expanded: "Close Companion" },
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
    const surface = { id: "resource-evidence" as const, body };
    const publication: PaneSecondaryPublication = {
      groupId: "resource-inspector",
      defaultSurfaceId: "resource-evidence",
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
        groupId: "resource-inspector",
        defaultSurfaceId: "resource-evidence",
        surfaces: [],
      }),
    ).toThrow("at least one surface");
    expect(() =>
      normalizePaneSecondaryPublication({
        groupId: "resource-inspector",
        defaultSurfaceId: "resource-evidence",
        surfaces: [
          { id: "resource-evidence", body },
          { id: "resource-evidence", body },
        ],
      }),
    ).toThrow("Duplicate secondary surface publication");
    expect(() =>
      normalizePaneSecondaryPublication({
        groupId: "resource-inspector",
        defaultSurfaceId: "resource-contents",
        surfaces: [{ id: "resource-evidence", body }],
      }),
    ).toThrow("is not published");
  });

  it("compares secondary publications by ordered surface ids and body identity", () => {
    const body = createElement("div");
    const otherBody = createElement("div");
    const publication: PaneSecondaryPublication = {
      groupId: "resource-inspector",
      defaultSurfaceId: "resource-evidence",
      surfaces: [
        { id: "resource-contents", body },
        { id: "resource-evidence", body },
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
          { id: "resource-evidence", body },
          { id: "resource-contents", body },
        ],
      }),
    ).toBe(false);
    expect(
      arePaneSecondaryPublicationsEqual(publication, {
        ...publication,
        surfaces: [
          { id: "resource-contents", body: otherBody },
          { id: "resource-evidence", body },
        ],
      }),
    ).toBe(false);
    expect(
      arePaneSecondaryPublicationsEqual(publication, {
        groupId: "resource-inspector",
        defaultSurfaceId: "resource-context",
        surfaces: [{ id: "resource-context", body }],
      }),
    ).toBe(false);
    expect(
      arePaneSecondaryPublicationsEqual(publication, {
        ...publication,
        defaultSurfaceId: "resource-contents",
      }),
    ).toBe(false);
    expect(
      arePaneSecondaryPublicationsEqual(publication, {
        ...publication,
        surfaces: [{ id: "resource-evidence", body }],
      }),
    ).toBe(false);
    expect(
      arePaneSecondaryPublicationsEqual(publication, {
        ...publication,
        surfaces: [
          { id: "resource-contents", body },
          { id: "resource-evidence", body: otherBody },
        ],
      }),
    ).toBe(false);
  });

  it("finds published secondary surfaces", () => {
    const body = createElement("div");
    const publication: PaneSecondaryPublication = {
      groupId: "resource-inspector",
      defaultSurfaceId: "resource-evidence",
      surfaces: [{ id: "resource-evidence", body }],
    };

    expect(getPublishedSecondarySurface(publication, "resource-evidence")).toEqual({
      id: "resource-evidence",
      body,
    });
    expect(getPublishedSecondarySurface(null, "resource-evidence")).toBeNull();
    expect(getPublishedSecondarySurface(publication, null)).toBeNull();
    expect(getPublishedSecondarySurface(publication, undefined)).toBeNull();
    expect(getPublishedSecondarySurface(publication, "resource-contents")).toBeNull();
    expect(secondaryPublicationIncludesSurface(publication, "resource-evidence")).toBe(true);
    expect(secondaryPublicationIncludesSurface(null, "resource-evidence")).toBe(false);
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
