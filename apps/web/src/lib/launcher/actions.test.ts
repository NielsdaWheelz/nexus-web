import { FileText } from "lucide-react";
import { describe, expect, it } from "vitest";
import { routeResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { LauncherItem } from "./model";
import { buildItemActions } from "./actions";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

function item(target: LauncherItem["target"]): LauncherItem {
  return {
    id: "result",
    title: "A resource",
    keywords: [],
    sectionId: "search-results",
    icon: FileText,
    target,
    source: "search",
    rank: {},
    hasActions: true,
  };
}

describe("buildItemActions", () => {
  it("projects resource Open, Share, and context Chat in canonical order", () => {
    const ref = `media:${MEDIA_ID}`;
    const subject = routeResourceActionSubject({
      scheme: "media",
      id: MEDIA_ID,
      href: `/media/${MEDIA_ID}`,
    });
    const actions = buildItemActions(
      item({
        kind: "ResourceOpen",
        subject,
      }),
    );

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
    expect(actions[1]?.target).toEqual({
      kind: "ResourceShare",
      subject,
    });
    expect(actions[2]?.target).toEqual({
      kind: "ResourceChat",
      ref,
    });
    expect(actions.some((action) => action.target.kind === "Ask")).toBe(false);
  });

  it("keeps generic Ask on non-resource items", () => {
    const actions = buildItemActions(
      item({
        kind: "href",
        href: "/search",
        externalShell: false,
      }),
    );

    expect(actions.find((action) => action.id === "ask")?.target).toEqual({
      kind: "Ask",
      text: "A resource",
    });
    expect(
      actions.some((action) => action.target.kind === "ResourceChat"),
    ).toBe(false);
  });

  it("keeps resource Chat when a chat-capable resource is unrouteable", () => {
    const ref = assumeCanonicalResourceRef(`contributor:${MEDIA_ID}`);
    const actions = buildItemActions(
      item({
        kind: "ResourceOpen",
        subject: {
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
      }),
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]?.target).toEqual({ kind: "ResourceChat", ref });
  });
});
