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

  it("delegates a route to the semantic workspace target capability", () => {
    const activateTarget = vi.fn();

    expect(
      activateResource(route, {
        activateTarget,
        disposition: { kind: "Follow" },
      }),
    ).toBe(true);

    expect(activateTarget).toHaveBeenCalledWith({
      target: { href: route.href },
      disposition: { kind: "Follow" },
    });
  });

  it("forwards label and secondary activation as target payload", () => {
    const activateTarget = vi.fn();
    const revisionRef =
      "artifact_revision:44444444-4444-4444-8444-444444444444";
    const activation = {
      ...route,
      resourceRef: revisionRef,
      href: "/conversations/33333333-3333-4333-8333-333333333333",
    };

    expect(
      activateResource(activation, {
        labelHint: "The Left Hand of Darkness",
        activateTarget,
        disposition: { kind: "Fork" },
      }),
    ).toBe(true);

    expect(activateTarget).toHaveBeenCalledWith({
      target: {
        href: activation.href,
        labelHint: "The Left Hand of Darkness",
        secondaryActivation: {
          kind: "DossierRevision",
          surfaceId: "resource-dossier",
          revisionRef,
        },
      },
      disposition: { kind: "Fork" },
    });
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
        { activateTarget: vi.fn(), disposition: { kind: "Follow" } },
      ),
    ).toBe(true);

    expect(assign).toHaveBeenCalledWith("https://example.test/source");
    expect(open).not.toHaveBeenCalled();
  });

  it("opens an external resource in a new browser tab when forked", () => {
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
        { activateTarget: vi.fn(), disposition: { kind: "Fork" } },
      ),
    ).toBe(true);

    expect(open).toHaveBeenCalledWith(
      "https://example.test/source",
      "_blank",
      "noopener,noreferrer",
    );
    expect(assign).not.toHaveBeenCalled();
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
