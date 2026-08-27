import type {
  ResourceItem,
  ResourceSurface,
  ResourceSurfaceOccurrence,
  SurfacePosition,
} from "@/lib/resources/resourceItems";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import type {
  ResourceSurfaceDraftIntent,
  ResourceSurfaceDraftPosition,
  ResourceSurfaceOccurrenceAnchor,
  ResourceSurfacePendingBody,
  ResourceSurfacePendingTitle,
} from "@/lib/resourceSurface/draftStore";
import { isCanonicalUuid } from "@/lib/validation";

const PENDING_OCCURRENCE_PREFIX = "pending:";

export type ResourceSurfaceCommand =
  | {
      type: "insert_note";
      noteId: string;
      position: SurfacePosition;
      bodyPmJson: Record<string, unknown>;
    }
  | {
      type: "split_note";
      occurrenceId: string;
      noteId: string;
      leftBodyPmJson: Record<string, unknown>;
      rightBodyPmJson: Record<string, unknown>;
    }
  | {
      type: "insert_resource";
      targetRef: string;
      position: SurfacePosition;
    }
  | {
      type: "move_occurrence";
      occurrenceId: string;
      position: SurfacePosition;
    }
  | { type: "remove_occurrence"; occurrenceId: string };

export function resourceSurfaceLaneVersion(
  item: ResourceItem,
  lane: "title" | "body" | "outgoing_edges",
): number {
  const value = item.versionByLane[lane];
  if (typeof value !== "number") {
    throw new Error(
      `Resource surface is missing ${lane} version for ${item.ref}`,
    );
  }
  return value;
}

export function resourceSurfaceOccurrenceForRef(
  surface: ResourceSurface,
  ref: string,
): ResourceSurfaceOccurrence | undefined {
  return surface.orderedItems.find((item) => item.target.item.ref === ref);
}

export function resourceSurfacePendingOccurrenceId(
  clientMutationId: string,
): string {
  return `${PENDING_OCCURRENCE_PREFIX}${clientMutationId}`;
}

function occurrenceAnchor(
  surface: ResourceSurface,
  occurrenceId: string,
): ResourceSurfaceOccurrenceAnchor | null {
  if (
    isCanonicalUuid(occurrenceId) &&
    surface.orderedItems.some((item) => item.occurrenceId === occurrenceId)
  ) {
    return { kind: "persisted", occurrenceId };
  }
  if (occurrenceId.startsWith(PENDING_OCCURRENCE_PREFIX)) {
    const clientMutationId = occurrenceId.slice(PENDING_OCCURRENCE_PREFIX.length);
    if (
      isCanonicalUuid(clientMutationId) &&
      surface.orderedItems.some((item) => item.occurrenceId === occurrenceId)
    ) {
      return { kind: "pending", clientMutationId };
    }
  }
  return null;
}

function materializeOccurrence(
  surface: ResourceSurface,
  anchor: ResourceSurfaceOccurrenceAnchor,
): ResourceSurfaceOccurrence | undefined {
  const occurrenceId =
    anchor.kind === "persisted"
      ? anchor.occurrenceId
      : resourceSurfacePendingOccurrenceId(anchor.clientMutationId);
  return surface.orderedItems.find(
    (item) => item.occurrenceId === occurrenceId,
  );
}

function materializePosition(
  surface: ResourceSurface,
  position: ResourceSurfaceDraftPosition,
): SurfacePosition | null {
  if (position.kind === "start") return { kind: "start" };
  const occurrence = materializeOccurrence(surface, position.anchor);
  return occurrence === undefined
    ? null
    : { kind: "after", occurrenceId: occurrence.occurrenceId };
}

function insertionIndex(
  items: readonly ResourceSurfaceOccurrence[],
  position: SurfacePosition,
): number {
  if (position.kind === "start") return 0;
  const index = items.findIndex(
    (item) => item.occurrenceId === position.occurrenceId,
  );
  if (index < 0) {
    throw new Error("Resource surface position is not in the source");
  }
  return index + 1;
}

function localOccurrence(input: {
  surface: ResourceSurface;
  noteId: string;
  bodyPmJson: Record<string, unknown>;
  clientMutationId: string;
}): ResourceSurfaceOccurrence {
  const ref = `note_block:${input.noteId}`;
  return {
    occurrenceId: resourceSurfacePendingOccurrenceId(input.clientMutationId),
    target: {
      item: {
        ...input.surface.source.item,
        ref,
        scheme: "note_block",
        id: input.noteId,
        label: "",
        summary: "",
        route: `/notes/${input.noteId}`,
        activation: {
          resourceRef: ref,
          kind: "route",
          href: `/notes/${input.noteId}`,
          unresolvedReason: null,
        },
        versionByLane: { body: 0, outgoing_edges: 0 },
      },
      content: {
        kind: "note_body",
        bodyPmJson: input.bodyPmJson,
        bodyText: "",
      },
    },
  };
}

function requireOccurrence(
  surface: ResourceSurface,
  occurrenceId: string,
): ResourceSurfaceOccurrence {
  const occurrence = surface.orderedItems.find(
    (item) => item.occurrenceId === occurrenceId,
  );
  if (occurrence === undefined) {
    throw new Error("Resource surface occurrence is not in the source");
  }
  return occurrence;
}

function projectResourceSurfaceCommand(
  surface: ResourceSurface,
  command: ResourceSurfaceCommand,
  clientMutationId: string,
): ResourceSurface {
  if (command.type === "remove_occurrence") {
    requireOccurrence(surface, command.occurrenceId);
    return {
      ...surface,
      orderedItems: surface.orderedItems.filter(
        (item) => item.occurrenceId !== command.occurrenceId,
      ),
    };
  }
  if (command.type === "move_occurrence") {
    const occurrence = requireOccurrence(surface, command.occurrenceId);
    const orderedItems = surface.orderedItems.filter(
      (item) => item !== occurrence,
    );
    orderedItems.splice(insertionIndex(orderedItems, command.position), 0, occurrence);
    return { ...surface, orderedItems };
  }
  if (command.type === "insert_note") {
    const orderedItems = [...surface.orderedItems];
    orderedItems.splice(
      insertionIndex(orderedItems, command.position),
      0,
      localOccurrence({
        surface,
        noteId: command.noteId,
        bodyPmJson: command.bodyPmJson,
        clientMutationId,
      }),
    );
    return { ...surface, orderedItems };
  }
  if (command.type === "split_note") {
    const occurrence = requireOccurrence(surface, command.occurrenceId);
    if (occurrence.target.content.kind !== "note_body") {
      throw new Error("Only note occurrences can be split");
    }
    const index = surface.orderedItems.indexOf(occurrence);
    const orderedItems = [...surface.orderedItems];
    orderedItems[index] = {
      ...occurrence,
      target: {
        ...occurrence.target,
        content: {
          kind: "note_body",
          bodyPmJson: command.leftBodyPmJson,
          bodyText: "",
        },
      },
    };
    orderedItems.splice(
      index + 1,
      0,
      localOccurrence({
        surface,
        noteId: command.noteId,
        bodyPmJson: command.rightBodyPmJson,
        clientMutationId,
      }),
    );
    return { ...surface, orderedItems };
  }

  const parsedTarget = parseResourceRef(command.targetRef);
  if (parsedTarget === null) {
    throw new TypeError("insert_resource targetRef must be canonical");
  }
  const orderedItems = [...surface.orderedItems];
  orderedItems.splice(insertionIndex(orderedItems, command.position), 0, {
    occurrenceId: resourceSurfacePendingOccurrenceId(clientMutationId),
    target: {
      item: {
        ...surface.source.item,
        ref: command.targetRef,
        scheme: parsedTarget.scheme,
        id: parsedTarget.id,
        label: "Resource",
        summary: "",
        route: null,
        activation: {
          resourceRef: command.targetRef,
          kind: "none",
          href: null,
          unresolvedReason: null,
        },
      },
      content: { kind: "resource_summary" },
    },
  });
  return { ...surface, orderedItems };
}

export function createResourceSurfaceIntent(input: {
  surface: ResourceSurface;
  command: ResourceSurfaceCommand;
  clientMutationId: string;
}): ResourceSurfaceDraftIntent | null {
  const occurrenceId =
    input.command.type === "split_note" ||
    input.command.type === "move_occurrence" ||
    input.command.type === "remove_occurrence"
      ? input.command.occurrenceId
      : undefined;
  const targetAnchor =
    occurrenceId === undefined
      ? undefined
      : occurrenceAnchor(input.surface, occurrenceId) ?? undefined;
  const rawPosition =
    input.command.type === "insert_note" ||
    input.command.type === "insert_resource" ||
    input.command.type === "move_occurrence"
      ? input.command.position
      : undefined;
  let position: ResourceSurfaceDraftPosition | undefined;
  if (rawPosition?.kind === "start") {
    position = rawPosition;
  } else if (rawPosition?.kind === "after") {
    const anchor = occurrenceAnchor(input.surface, rawPosition.occurrenceId);
    if (anchor === null) return null;
    position = { kind: "after", anchor };
  }
  if (occurrenceId !== undefined && targetAnchor === undefined) return null;
  return {
    clientMutationId: input.clientMutationId,
    command: input.command,
    occurrenceAnchor: targetAnchor,
    position,
  };
}

export function materializeResourceSurfaceIntent(
  surface: ResourceSurface,
  intent: ResourceSurfaceDraftIntent,
): ResourceSurfaceCommand | null {
  const occurrence = intent.occurrenceAnchor
    ? materializeOccurrence(surface, intent.occurrenceAnchor)
    : undefined;
  const position = intent.position
    ? materializePosition(surface, intent.position)
    : undefined;
  const command = intent.command;
  if (command.type === "insert_note" && position) return { ...command, position };
  if (command.type === "insert_resource" && position) {
    return { ...command, position };
  }
  if (command.type === "move_occurrence" && occurrence && position) {
    return { ...command, occurrenceId: occurrence.occurrenceId, position };
  }
  if (command.type === "remove_occurrence" && occurrence) {
    return { ...command, occurrenceId: occurrence.occurrenceId };
  }
  if (command.type === "split_note" && occurrence) {
    return { ...command, occurrenceId: occurrence.occurrenceId };
  }
  return null;
}

function createdOccurrenceTargetRef(
  command: ResourceSurfaceCommand,
): string | null {
  switch (command.type) {
    case "insert_note":
    case "split_note":
      return `note_block:${command.noteId}`;
    case "insert_resource":
      return command.targetRef;
    case "move_occurrence":
    case "remove_occurrence":
      return null;
  }
}

function rebindAcknowledgedAnchor(
  anchor: ResourceSurfaceOccurrenceAnchor,
  completedClientMutationId: string,
  occurrenceId: string,
): ResourceSurfaceOccurrenceAnchor {
  return anchor.kind === "pending" &&
    anchor.clientMutationId === completedClientMutationId
    ? { kind: "persisted", occurrenceId }
    : anchor;
}

export function rebindAcknowledgedResourceSurfaceIntents(input: {
  previousSurface: ResourceSurface;
  acknowledgedSurface: ResourceSurface;
  completedIntent: ResourceSurfaceDraftIntent;
  remainingIntents: readonly ResourceSurfaceDraftIntent[];
}): ResourceSurfaceDraftIntent[] {
  const expectedRef = createdOccurrenceTargetRef(input.completedIntent.command);
  if (expectedRef === null) {
    return [...input.remainingIntents];
  }
  const previousIds = new Set(
    input.previousSurface.orderedItems.map((item) => item.occurrenceId),
  );
  const created = input.acknowledgedSurface.orderedItems.filter(
    (item) => !previousIds.has(item.occurrenceId),
  );
  const acknowledgedIds = new Set(
    input.acknowledgedSurface.orderedItems.map((item) => item.occurrenceId),
  );
  const createdOccurrence = created[0];
  if (
    created.length !== 1 ||
    createdOccurrence === undefined ||
    input.previousSurface.orderedItems.some(
      (item) => !acknowledgedIds.has(item.occurrenceId),
    )
  ) {
    throw new Error(
      "Resource surface insertion acknowledgement must create one occurrence",
    );
  }
  if (createdOccurrence.target.item.ref !== expectedRef) {
    throw new Error(
      "Resource surface insertion acknowledgement must match its target",
    );
  }
  const completedClientMutationId = input.completedIntent.clientMutationId;
  const occurrenceId = createdOccurrence.occurrenceId;
  return input.remainingIntents.map((intent) => ({
    ...intent,
    ...(intent.occurrenceAnchor === undefined
      ? {}
      : {
          occurrenceAnchor: rebindAcknowledgedAnchor(
            intent.occurrenceAnchor,
            completedClientMutationId,
            occurrenceId,
          ),
        }),
    ...(intent.position?.kind !== "after"
      ? {}
      : {
          position: {
            kind: "after" as const,
            anchor: rebindAcknowledgedAnchor(
              intent.position.anchor,
              completedClientMutationId,
              occurrenceId,
            ),
          },
        }),
  }));
}

export function projectResourceSurface(input: {
  acknowledgedSurface: ResourceSurface;
  intents: readonly ResourceSurfaceDraftIntent[];
  title: ResourceSurfacePendingTitle | undefined;
  bodies: ReadonlyMap<string, ResourceSurfacePendingBody>;
}): ResourceSurface {
  let surface = input.acknowledgedSurface;
  for (const intent of input.intents) {
    const command = materializeResourceSurfaceIntent(surface, intent);
    if (command === null) {
      throw new Error(
        "Queued resource surface intent cannot materialize against its owner",
      );
    }
    surface = projectResourceSurfaceCommand(
      surface,
      command,
      intent.clientMutationId,
    );
  }
  if (input.title !== undefined && surface.source.content.kind === "page_title") {
    surface = {
      ...surface,
      source: {
        ...surface.source,
        content: { kind: "page_title", title: input.title.value },
      },
    };
  }
  const projectBody = (
    occurrence: ResourceSurfaceOccurrence,
  ): ResourceSurfaceOccurrence => {
    const body = input.bodies.get(occurrence.target.item.ref);
    return body !== undefined && occurrence.target.content.kind === "note_body"
      ? {
          ...occurrence,
          target: {
            ...occurrence.target,
            content: {
              kind: "note_body",
              bodyPmJson: body.bodyPmJson,
              bodyText: body.bodyText,
            },
          },
        }
      : occurrence;
  };
  surface = {
    ...surface,
    orderedItems: surface.orderedItems.map(projectBody),
  };
  const sourceBody = input.bodies.get(surface.source.item.ref);
  return sourceBody !== undefined && surface.source.content.kind === "note_body"
    ? {
        ...surface,
        source: {
          ...surface.source,
          content: {
            kind: "note_body",
            bodyPmJson: sourceBody.bodyPmJson,
            bodyText: sourceBody.bodyText,
          },
        },
      }
    : surface;
}
