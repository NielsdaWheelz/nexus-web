import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateResource,
  secondaryActivationForResource,
  type ResourceActivation,
} from "./activation";

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

  it("forwards the pane label hint through route activation", () => {
    const openInNewPane = vi.fn();

    expect(
      activateResource(route, {
        labelHint: "The Left Hand of Darkness",
        openInNewPane,
        newPane: true,
      }),
    ).toBe(true);

    expect(openInNewPane).toHaveBeenCalledWith(
      route.href,
      "The Left Hand of Darkness",
    );
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

  it("routes artifact revisions through the typed Dossier workspace command", () => {
    const openInNewPane = vi.fn();
    const revisionRef =
      "artifact_revision:44444444-4444-4444-8444-444444444444";
    const activation = {
      ...route,
      resourceRef: revisionRef,
      href: "/conversations/33333333-3333-4333-8333-333333333333",
    };

    expect(activateResource(activation, { openInNewPane })).toBe(true);
    expect(openInNewPane).toHaveBeenCalledWith(
      activation.href,
      undefined,
      {
        kind: "DossierRevision",
        surfaceId: "resource-dossier",
        revisionRef,
      },
    );
  });
});

describe("secondaryActivationForResource", () => {
  it("opens an artifact head on the current Dossier", () => {
    expect(
      secondaryActivationForResource({
        ...route,
        resourceRef: "artifact:22222222-2222-4222-8222-222222222222",
        href: "/conversations/33333333-3333-4333-8333-333333333333",
      }),
    ).toEqual({ kind: "DossierCurrent", surfaceId: "resource-dossier" });
  });

  it("opens an artifact revision on that exact historical Dossier", () => {
    const revisionRef =
      "artifact_revision:44444444-4444-4444-8444-444444444444";
    expect(
      secondaryActivationForResource({
        ...route,
        resourceRef: revisionRef,
        href: "/conversations/33333333-3333-4333-8333-333333333333",
      }),
    ).toEqual({
      kind: "DossierRevision",
      surfaceId: "resource-dossier",
      revisionRef,
    });
  });
});
