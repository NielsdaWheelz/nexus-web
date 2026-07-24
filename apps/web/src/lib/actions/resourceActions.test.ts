import { describe, expect, it, vi } from "vitest";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { assumeLecternItemId } from "@/lib/lectern/contract";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import {
  RESOURCE_ACTION_CATALOG,
  composeResourceMenu,
  conversationResourceOptions,
  episodeResourceOptions,
  libraryResourceOptions,
  mediaResourceOptions,
  podcastResourceOptions,
  projectResourceActionToHeader,
  projectResourceActionToMenu,
  resolveResourceCoreActions,
  type ActionPublication,
  type ExecutableResourceAction,
  type RichResourceActionGroups,
  type ResourceActionId,
  type ResourceMenuGroups,
} from "@/lib/actions/resourceActions";

const UUID = "00000000-0000-4000-8000-000000000001";
const MEDIA_REF = assumeCanonicalResourceRef(`media:${UUID}`);
const noAction = { kind: "Unavailable" } as const;
const noBusy = new Set<ResourceActionId>();

function available(
  execute = vi.fn(),
): Extract<ExecutableResourceAction, { kind: "Available" }> {
  return { kind: "Available", execute };
}

function descriptor(id: string, tone?: "default" | "danger"): ActionDescriptor {
  return {
    kind: "command",
    id,
    label: id,
    tone,
    onSelect: vi.fn(),
  };
}

function ids(groups: ResourceMenuGroups): string[] {
  return composeResourceMenu(groups).map((action) => action.id);
}

function richMenu(
  groups: RichResourceActionGroups,
  input: {
    core?: readonly ActionDescriptor[];
    view?: readonly ActionDescriptor[];
  } = {},
): ResourceMenuGroups {
  return {
    core: input.core ?? [],
    operations: groups.operations,
    relationships: groups.relationships,
    view: input.view ?? [],
  };
}

function command(groups: ResourceMenuGroups, id: string) {
  const action = composeResourceMenu(groups).find((candidate) => candidate.id === id);
  if (!action || action.kind !== "command") {
    throw new Error(`Missing command ${id}`);
  }
  return action;
}

describe("resource action catalog and projections", () => {
  it("owns unique dot-delimited PascalCase ids", () => {
    const ids = Object.values(RESOURCE_ACTION_CATALOG).map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^(?:[A-Z][A-Za-z0-9]*)(?:\.[A-Z][A-Za-z0-9]*)+$/.test(id))).toBe(
      true,
    );
  });

  it("projects Share metadata identically into menus and headers", () => {
    const semantic = {
      kind: "command",
      catalogKey: "Share",
      onSelect: vi.fn(),
    } as const;
    const menu = projectResourceActionToMenu(semantic);
    const header = projectResourceActionToHeader(semantic);
    expect(menu).toMatchObject({
      id: "ResourceAction.Share",
      label: "Share…",
      restoreFocusOnClose: false,
    });
    expect(header).toMatchObject({
      id: menu.id,
      label: menu.label,
      tone: menu.tone,
      restoreFocusOnClose: false,
    });
    expect(menu.icon?.type).toBe(header.icon.type);
  });

  it("owns cross-surface Edit authors operation metadata", () => {
    expect(
      projectResourceActionToMenu({
        kind: "command",
        catalogKey: "EditAuthors",
        onSelect: vi.fn(),
      }),
    ).toMatchObject({
      id: "ResourceOperation.Media.EditAuthors",
      label: "Edit authors…",
    });
  });

  it("requires an accessible reason when a busy label does not explain state", () => {
    expect(() =>
      projectResourceActionToMenu({
        kind: "command",
        catalogKey: "Share",
        busy: true,
        onSelect: vi.fn(),
      }),
    ).toThrow("Busy resource action requires disabledReason");
    expect(
      projectResourceActionToMenu({
        kind: "command",
        catalogKey: "Share",
        busy: true,
        disabledReason: "Creating highlight",
        onSelect: vi.fn(),
      }),
    ).toMatchObject({
      id: "ResourceAction.Share",
      disabled: true,
      disabledReason: "Creating highlight",
    });
  });

  it("requires a standing target on resource publications", () => {
    const target: ResourceActionSubject = {
      kind: "Resource",
      ref: MEDIA_REF,
      activation: {
        resourceRef: MEDIA_REF,
        kind: "route",
        href: `/media/${UUID}`,
        unresolvedReason: null,
      },
      missing: false,
    };
    const publication: ActionPublication = {
      kind: "ResourceMenu",
      target,
      groups: {
        core: [],
        operations: [],
        relationships: [],
        view: [],
      },
    };
    expect(publication.target).toBe(target);
  });
});

describe("resolveResourceCoreActions", () => {
  const subject: ResourceActionSubject = {
    kind: "Resource",
    ref: MEDIA_REF,
    activation: {
      resourceRef: MEDIA_REF,
      kind: "route",
      href: `/media/${UUID}`,
      unresolvedReason: null,
    },
    missing: false,
  };

  it("projects the same universal core for every representation", () => {
    const executors = {
      open: vi.fn(),
      share: vi.fn(),
      chat: vi.fn(),
    };
    const groups = resolveResourceCoreActions({
      target: subject,
      projection: "Representation",
      busyIds: noBusy,
      executors,
    });
    expect(ids(groups)).toEqual([
      "ResourceAction.Open",
      "ResourceAction.Share",
      "ResourceAction.Chat",
    ]);

    command(groups, "ResourceAction.Share").onSelect({ triggerEl: null });
    expect(executors.share).toHaveBeenCalledWith(subject, { triggerEl: null });
  });

  it("omits Open in the current pane but keeps applicable Share and Chat", () => {
    const groups = resolveResourceCoreActions({
      target: subject,
      projection: "CurrentPane",
      busyIds: noBusy,
      executors: { share: vi.fn(), chat: vi.fn() },
    });
    expect(ids(groups)).toEqual([
      "ResourceAction.Share",
      "ResourceAction.Chat",
    ]);
  });

  it("emits no core for missing resources and Chat only for unrouteable media", () => {
    const executors = { open: vi.fn(), share: vi.fn(), chat: vi.fn() };
    expect(
      ids(
        resolveResourceCoreActions({
          target: { ...subject, missing: true },
          projection: "Representation",
          busyIds: noBusy,
          executors,
        }),
      ),
    ).toEqual([]);
    expect(
      ids(
        resolveResourceCoreActions({
          target: {
            ...subject,
            activation: {
              resourceRef: MEDIA_REF,
              kind: "none",
              href: null,
              unresolvedReason: "Unavailable",
            },
          },
          projection: "Representation",
          busyIds: noBusy,
          executors,
        }),
      ),
    ).toEqual(["ResourceAction.Chat"]);
  });

  it("gives external targets Open only", () => {
    const groups = resolveResourceCoreActions({
      target: { kind: "External", href: "https://example.com" },
      projection: "Representation",
    });
    expect(ids(groups)).toEqual(["ExternalAction.Open"]);
    expect(groups.core[0]).toMatchObject({
      kind: "link",
      href: "https://example.com",
    });
  });

  it("keeps resource Chat visible with an explanatory busy state", () => {
    const groups = resolveResourceCoreActions({
      target: subject,
      projection: "CurrentPane",
      busyIds: new Set([RESOURCE_ACTION_CATALOG.Chat.id]),
      executors: { share: vi.fn(), chat: vi.fn() },
    });
    expect(command(groups, "ResourceAction.Chat")).toMatchObject({
      label: "Starting chat...",
      disabled: true,
    });
  });

  it("defects on mismatched ref and activation identity", () => {
    expect(() =>
      resolveResourceCoreActions({
        target: {
          ...subject,
          activation: { ...subject.activation, resourceRef: `page:${UUID}` },
        },
        projection: "Representation",
        busyIds: noBusy,
        executors: { open: vi.fn(), share: vi.fn(), chat: vi.fn() },
      }),
    ).toThrow("Invalid resource action target");
  });
});

describe("composeResourceMenu", () => {
  it("owns group separators and stable danger-last ordering without mutation", () => {
    const originalCore = descriptor("ResourceAction.Open");
    const originalOperation = {
      ...descriptor("ResourceOperation.Read"),
      separatorBefore: true,
    };
    const originalDanger = descriptor(
      "ResourceOperation.Delete",
      "danger",
    );
    const groups: ResourceMenuGroups = {
      core: [originalCore],
      operations: [originalOperation, originalDanger],
      relationships: [descriptor("RelationshipAction.Remove")],
      view: [descriptor("ViewAction.Toggle")],
    };

    const result = composeResourceMenu(groups);
    expect(result.map((action) => [action.id, action.separatorBefore])).toEqual([
      ["ResourceAction.Open", undefined],
      ["ResourceOperation.Read", true],
      ["RelationshipAction.Remove", true],
      ["ViewAction.Toggle", true],
      ["ResourceOperation.Delete", true],
    ]);
    expect(originalOperation.separatorBefore).toBe(true);
    expect(result[1]).not.toBe(originalOperation);
  });

  it("discards every caller separator and preserves stable order inside ordinary and danger partitions", () => {
    const coreSecond = {
      ...descriptor("ResourceAction.Chat"),
      separatorBefore: true,
    };
    const firstDanger = descriptor(
      "ResourceOperation.FirstDanger",
      "danger",
    );
    const secondDanger = {
      ...descriptor("RelationshipAction.SecondDanger", "danger"),
      separatorBefore: true,
    };
    const groups: ResourceMenuGroups = Object.freeze({
      core: Object.freeze([
        descriptor("ResourceAction.Open"),
        coreSecond,
        firstDanger,
      ]),
      operations: Object.freeze([]),
      relationships: Object.freeze([
        descriptor("RelationshipAction.Keep"),
        secondDanger,
      ]),
      view: Object.freeze([]),
    });

    expect(
      composeResourceMenu(groups).map((action) => [
        action.id,
        action.separatorBefore,
      ]),
    ).toEqual([
      ["ResourceAction.Open", undefined],
      ["ResourceAction.Chat", undefined],
      ["RelationshipAction.Keep", true],
      ["ResourceOperation.FirstDanger", true],
      ["RelationshipAction.SecondDanger", undefined],
    ]);
    expect(coreSecond.separatorBefore).toBe(true);
    expect(secondDanger.separatorBefore).toBe(true);
  });

  it("returns an empty projection from frozen empty semantic groups", () => {
    const groups = Object.freeze({
      core: Object.freeze([]),
      operations: Object.freeze([]),
      relationships: Object.freeze([]),
      view: Object.freeze([]),
    });
    expect(composeResourceMenu(groups)).toEqual([]);
  });

  it("defects on duplicate ids across groups", () => {
    expect(() =>
      composeResourceMenu({
        core: [descriptor("ResourceAction.Share")],
        operations: [],
        relationships: [descriptor("ResourceAction.Share")],
        view: [],
      }),
    ).toThrow("Duplicate resource action id: ResourceAction.Share");
  });
});

describe("rich resource builders", () => {
  const media = {
    id: UUID,
    title: "Designing Data-Intensive Applications",
    canonical_source_url: "https://example.com/source",
  };

  it("builds media operations and exactly one Lectern relationship from typed capabilities", () => {
    const retry = vi.fn();
    const editAuthors = vi.fn();
    const remove = vi.fn();
    const busyIds = new Set<ResourceActionId>([
      RESOURCE_ACTION_CATALOG.RetryProcessing.id,
      RESOURCE_ACTION_CATALOG.RemoveMedia.id,
    ]);
    const groups = mediaResourceOptions({
      media,
      retryProcessing: available(retry),
      refreshSource: noAction,
      retryMetadata: noAction,
      editAuthors: available(editAuthors),
      lecternMembership: { kind: "Add", execute: vi.fn() },
      readState: { kind: "MarkFinished", execute: vi.fn() },
      removeMedia: available(remove),
      busyIds,
    });

    const menu = richMenu(groups, {
      core: [descriptor("ResourceAction.Share")],
    });
    expect(ids(menu)).toEqual([
      "ResourceAction.Share",
      "ResourceOperation.OpenSource",
      "ResourceOperation.Media.RetryProcessing",
      "ResourceOperation.Media.EditAuthors",
      "ResourceOperation.Media.MarkFinished",
      "RelationshipAction.Lectern.Add",
      "ResourceOperation.Media.Remove",
    ]);
    expect(command(menu, "ResourceOperation.Media.RetryProcessing")).toMatchObject({
      label: "Retrying...",
      disabled: true,
    });
    expect(command(menu, "ResourceOperation.Media.Remove")).toMatchObject({
      label: "Removing...",
      disabled: true,
      tone: "danger",
    });
    command(menu, "ResourceOperation.Media.EditAuthors").onSelect({
      triggerEl: null,
    });
    expect(editAuthors).toHaveBeenCalledOnce();
  });

  it("projects Remove instead of Add from explicit Lectern membership", () => {
    const remove = vi.fn();
    const groups = mediaResourceOptions({
      media,
      retryProcessing: noAction,
      refreshSource: noAction,
      retryMetadata: noAction,
      editAuthors: noAction,
      lecternMembership: {
        kind: "Remove",
        itemId: assumeLecternItemId(
          "11111111-0000-4000-8000-000000000002",
        ),
        execute: remove,
      },
      readState: noAction,
      removeMedia: noAction,
      busyIds: noBusy,
    });

    const menu = richMenu(groups);
    expect(ids(menu)).toEqual([
      "ResourceOperation.OpenSource",
      "RelationshipAction.Lectern.Remove",
    ]);
    command(menu, "RelationshipAction.Lectern.Remove").onSelect({
      triggerEl: null,
    });
    expect(remove).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "media alternate capabilities",
      () => {
        const refresh = vi.fn();
        const metadata = vi.fn();
        const markUnread = vi.fn();
        const removeFromLectern = vi.fn();
        return {
          groups: mediaResourceOptions({
            media,
            retryProcessing: noAction,
            refreshSource: available(refresh),
            retryMetadata: available(metadata),
            editAuthors: noAction,
            lecternMembership: {
              kind: "Remove",
              itemId: assumeLecternItemId(
                "22222222-0000-4000-8000-000000000002",
              ),
              execute: removeFromLectern,
            },
            readState: {
              kind: "MarkUnread",
              execute: markUnread,
            },
            removeMedia: noAction,
            busyIds: noBusy,
          }),
          expected: [
            "ResourceOperation.OpenSource",
            "ResourceOperation.Media.RefreshSource",
            "ResourceOperation.Media.RetryMetadata",
            "ResourceOperation.Media.MarkUnread",
            "RelationshipAction.Lectern.Remove",
          ],
          executors: [
            refresh,
            metadata,
            markUnread,
            removeFromLectern,
          ],
        };
      },
    ],
    [
      "episode alternate played state",
      () => {
        const markUnplayed = vi.fn();
        return {
          groups: episodeResourceOptions({
            media,
            retryProcessing: noAction,
            refreshSource: noAction,
            retryMetadata: noAction,
            editAuthors: noAction,
            lecternMembership: noAction,
            removeMedia: noAction,
            playedState: {
              kind: "MarkUnplayed",
              execute: markUnplayed,
            },
            busyIds: noBusy,
          }),
          expected: [
            "ResourceOperation.OpenSource",
            "ResourceOperation.Episode.MarkUnplayed",
          ],
          executors: [markUnplayed],
        };
      },
    ],
    [
      "library alternate capabilities",
      () => {
        const deleteLibrary = vi.fn();
        return {
          groups: libraryResourceOptions({
            settings: noAction,
            deleteLibrary: available(deleteLibrary),
            busyIds: noBusy,
          }),
          expected: ["ResourceOperation.Library.Delete"],
          executors: [deleteLibrary],
        };
      },
    ],
    [
      "podcast unavailable capabilities",
      () => ({
        groups: podcastResourceOptions({
          settings: noAction,
          refreshSync: noAction,
          subscription: noAction,
          busyIds: noBusy,
        }),
        expected: [],
        executors: [],
      }),
    ],
    [
      "conversation unavailable capability",
      () => ({
        groups: conversationResourceOptions({
          deleteConversation: noAction,
          busyIds: noBusy,
        }),
        expected: [],
        executors: [],
      }),
    ],
  ] as const)("%s projects only its legal actions and executes each once", (
    _name,
    build,
  ) => {
    const projection = build();
    const menu = richMenu(projection.groups);
    expect(ids(menu)).toEqual(projection.expected);
    for (const action of composeResourceMenu(menu)) {
      if (action.kind === "command") {
        action.onSelect({ triggerEl: null });
      }
    }
    for (const execute of projection.executors) {
      expect(execute).toHaveBeenCalledOnce();
    }
  });

  it("builds only applicable library operations", () => {
    const groups = libraryResourceOptions({
      settings: available(),
      deleteLibrary: noAction,
      busyIds: noBusy,
    });
    expect(ids(richMenu(groups))).toEqual(["ResourceOperation.Library.Settings"]);
  });

  it("keeps podcast unsubscribe in the relationship group and danger-last", () => {
    const groups = podcastResourceOptions({
      settings: available(),
      refreshSync: available(),
      subscription: { kind: "Subscribed", execute: vi.fn() },
      busyIds: new Set([
        RESOURCE_ACTION_CATALOG.RefreshPodcast.id,
        RESOURCE_ACTION_CATALOG.UnsubscribePodcast.id,
      ]),
    });
    const menu = richMenu(groups, {
      core: [descriptor("ResourceAction.Share")],
    });
    expect(ids(menu)).toEqual([
      "ResourceAction.Share",
      "ResourceOperation.Podcast.Settings",
      "ResourceOperation.Podcast.Refresh",
      "RelationshipAction.Podcast.Unsubscribe",
    ]);
    expect(command(menu, "RelationshipAction.Podcast.Unsubscribe")).toMatchObject({
      label: "Unsubscribing...",
      disabled: true,
      tone: "danger",
    });
  });

  it("keeps episode view actions out of the rich builder", () => {
    const groups = episodeResourceOptions({
      media,
      retryProcessing: noAction,
      refreshSource: noAction,
      retryMetadata: noAction,
      editAuthors: noAction,
      lecternMembership: noAction,
      removeMedia: noAction,
      playedState: { kind: "MarkPlayed", execute: vi.fn() },
      busyIds: noBusy,
    });
    expect(Object.keys(groups).sort()).toEqual(["operations", "relationships"]);
    expect(ids(richMenu(groups))).toEqual([
      "ResourceOperation.OpenSource",
      "ResourceOperation.Episode.MarkPlayed",
    ]);
  });

  it("projects conversation deletion from an explicit applicable variant", () => {
    const groups = conversationResourceOptions({
      deleteConversation: available(),
      busyIds: new Set([
        RESOURCE_ACTION_CATALOG.DeleteConversation.id,
      ]),
    });
    expect(command(richMenu(groups), "ResourceOperation.Conversation.Delete")).toMatchObject({
      label: "Deleting...",
      disabled: true,
      tone: "danger",
    });
  });
});

describe("relationship catalog copy", () => {
  it("names the affected relationship explicitly", () => {
    expect(RESOURCE_ACTION_CATALOG.RemoveFromContext.label).toBe(
      "Remove from conversation context",
    );
    expect(RESOURCE_ACTION_CATALOG.UnlinkConnection.label).toBe(
      "Unlink connection",
    );
    expect(RESOURCE_ACTION_CATALOG.DismissConnection.label).toBe(
      "Dismiss connection",
    );
  });
});
