import { describe, expect, it } from "vitest";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { buildResourceNexusActions } from "./actions";

const RESOURCE_ID = "11111111-1111-4111-8111-111111111111";

describe("Nexus resource actions", () => {
  it("projects the canonical Open, Share, and Chat catalog in owner order", () => {
    const subject = routeResourceActionSubject({
      scheme: "media",
      id: RESOURCE_ID,
      href: `/media/${RESOURCE_ID}`,
    });
    const actions = buildResourceNexusActions(subject, "A resource");

    expect(actions.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "ResourceAction.Open", label: "Open" },
      { id: "ResourceAction.Share", label: "Share…" },
      { id: "ResourceAction.Chat", label: "Chat about this resource" },
    ]);
    expect(actions[0]?.target).toEqual({
      kind: "ResourceOpen",
      subject,
      labelHint: "A resource",
    });
  });

  it("keeps an unrouteable but chat-capable resource actionable without inventing Open", () => {
    const ref = assumeCanonicalResourceRef(`contributor:${RESOURCE_ID}`);
    const actions = buildResourceNexusActions(
      {
        kind: "Resource",
        ref,
        missing: false,
        activation: {
          resourceRef: ref,
          kind: "none",
          href: null,
          unresolvedReason: "not_routeable",
        },
      },
      "A contributor",
    );

    expect(actions.map((action) => action.target)).toEqual([
      { kind: "ResourceChat", ref },
    ]);
  });
});
