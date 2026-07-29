import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { ActionPublication } from "@/lib/actions/resourceActions";
import {
  arePaneFixedChromePublicationsEqual,
  arePanePrimaryChromePublicationsEqual,
  arePaneSecondaryPublicationsEqual,
  getPublishedSecondarySurface,
  getPublishedTransientSecondarySurface,
  normalizePaneFixedChromePublication,
  normalizePaneSecondaryPublication,
  secondaryPublicationIncludesSurface,
  type PaneSecondaryPublication,
  type PanePrimaryChromePublication,
} from "@/lib/panes/panePublications";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";

const RESOURCE_ID = "00000000-0000-4000-8000-000000000001";
const RESOURCE_REF = assumeCanonicalResourceRef(`media:${RESOURCE_ID}`);
const OTHER_RESOURCE_REF = assumeCanonicalResourceRef(
  "media:00000000-0000-4000-8000-000000000002",
);

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
      menu: {
        kind: "FlatMenu",
        actions: [{
          kind: "command",
          id: "credits",
          label: "Credits…",
          onSelect,
        }],
      },
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
      menu: publication.menu?.kind === "FlatMenu"
        ? { kind: "FlatMenu", actions: [...publication.menu.actions] }
        : publication.menu,
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
      menu: {
        kind: "FlatMenu",
        actions: [{
          kind: "command",
          id: "credits",
          label: "Credits…",
          onSelect: () => {},
        }],
      },
    })).toBe(false);
  });

  it("compares FlatMenu disabled reasons as semantic descriptor state", () => {
    const onSelect = () => {};
    const action = {
      kind: "command",
      id: "busy",
      label: "Starting...",
      disabled: true,
      disabledReason: "A request is already in progress",
      onSelect,
    } as const;
    const left: PanePrimaryChromePublication = {
      menu: {
        kind: "FlatMenu",
        actions: [action],
      },
    };
    expect(arePanePrimaryChromePublicationsEqual(left, {
      menu: {
        kind: "FlatMenu",
        actions: [{
          ...action,
          disabledReason: "Waiting for another request",
        }],
      },
    })).toBe(false);
  });

  it("compares ResourceMenu target identity, activation, missing state, and all four groups", () => {
    const onSelect = () => {};
    const target: ResourceActionSubject = {
      kind: "Resource",
      ref: RESOURCE_REF,
      activation: {
        resourceRef: RESOURCE_REF,
        kind: "route",
        href: `/media/${RESOURCE_ID}`,
        unresolvedReason: null,
      },
      missing: false,
    };
    const menu: Extract<ActionPublication, { kind: "ResourceMenu" }> = {
      kind: "ResourceMenu",
      target,
      groups: {
        core: [{ kind: "command", id: "core", label: "Core", onSelect }],
        operations: [{
          kind: "command",
          id: "operation",
          label: "Operation",
          onSelect,
        }],
        relationships: [{
          kind: "command",
          id: "relationship",
          label: "Relationship",
          onSelect,
        }],
        view: [{ kind: "command", id: "view", label: "View", onSelect }],
      },
    };
    const publication: PanePrimaryChromePublication = { menu };

    expect(arePanePrimaryChromePublicationsEqual(publication, {
      menu: {
        kind: "ResourceMenu",
        target: {
          ...target,
          activation: { ...target.activation },
        },
        groups: {
          core: [...menu.groups.core],
          operations: [...menu.groups.operations],
          relationships: [...menu.groups.relationships],
          view: [...menu.groups.view],
        },
      },
    })).toBe(true);
    const unequalTargets: ResourceActionSubject[] = [
      { ...target, ref: OTHER_RESOURCE_REF },
      { ...target, missing: true },
      {
        ...target,
        activation: {
          ...target.activation,
          resourceRef: OTHER_RESOURCE_REF,
        },
      },
      {
        ...target,
        activation: {
          ...target.activation,
          kind: "external",
        },
      },
      {
        ...target,
        activation: {
          ...target.activation,
          href: `/media/${RESOURCE_ID}?other=1`,
        },
      },
      {
        ...target,
        activation: {
          ...target.activation,
          unresolvedReason: "Unavailable",
        },
      },
    ];
    for (const unequalTarget of unequalTargets) {
      expect(arePanePrimaryChromePublicationsEqual(publication, {
        menu: { ...menu, target: unequalTarget },
      })).toBe(false);
    }

    for (const groupName of [
      "core",
      "operations",
      "relationships",
      "view",
    ] as const) {
      expect(arePanePrimaryChromePublicationsEqual(publication, {
        menu: {
          ...menu,
          groups: {
            ...menu.groups,
            [groupName]: [{
              ...menu.groups[groupName][0]!,
              label: `Changed ${groupName}`,
            }],
          },
        },
      })).toBe(false);
    }
  });

  it("compares External ResourceMenu targets by href", () => {
    const menu: Extract<ActionPublication, { kind: "ResourceMenu" }> = {
      kind: "ResourceMenu",
      target: { kind: "External", href: "https://example.com/work" },
      groups: {
        core: [],
        operations: [],
        relationships: [],
        view: [],
      },
    };
    const publication: PanePrimaryChromePublication = {
      menu,
    };
    expect(arePanePrimaryChromePublicationsEqual(publication, {
      menu: {
        ...menu,
        target: { kind: "External", href: "https://example.com/work" },
      },
    })).toBe(true);
    expect(arePanePrimaryChromePublicationsEqual(publication, {
      menu: {
        ...menu,
        target: { kind: "External", href: "https://example.com/other" },
      },
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

  it("normalizes a transient-only publication without minting a durable default", () => {
    const body = createElement("div");
    const publication: PaneSecondaryPublication = {
      groupId: "resource-inspector",
      surfaces: [],
      defaultSurfaceId: null,
      transientSurfaces: [{ id: "resource-search", body }],
    };

    const normalized = normalizePaneSecondaryPublication(publication);

    expect(normalized).toEqual(publication);
    expect(normalized.transientSurfaces).not.toBe(
      publication.transientSurfaces,
    );
    expect(getPublishedTransientSecondarySurface(
      normalized,
      "resource-search",
    )).toEqual({ id: "resource-search", body });
  });

  it("rejects invalid secondary publications", () => {
    const body = createElement("div");

    expect(() =>
      normalizePaneSecondaryPublication({
        groupId: "resource-inspector",
        defaultSurfaceId: "resource-evidence",
        surfaces: [],
      }),
    ).toThrow("published together");
    expect(() =>
      normalizePaneSecondaryPublication({
        groupId: "resource-inspector",
        defaultSurfaceId: null,
        surfaces: [],
      }),
    ).toThrow("durable or transient surface");
    expect(() =>
      normalizePaneSecondaryPublication({
        groupId: "resource-inspector",
        defaultSurfaceId: null,
        surfaces: [{ id: "resource-evidence", body }],
      }),
    ).toThrow("published together");
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
      arePaneSecondaryPublicationsEqual(
        {
          ...publication,
          transientSurfaces: [{ id: "resource-search", body }],
        },
        {
          ...publication,
          transientSurfaces: [{ id: "resource-search", body }],
        },
      ),
    ).toBe(true);
    expect(
      arePaneSecondaryPublicationsEqual(
        {
          ...publication,
          transientSurfaces: [{ id: "resource-search", body }],
        },
        {
          ...publication,
          transientSurfaces: [{ id: "resource-search", body: otherBody }],
        },
      ),
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
