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
  ResourceSurfacePendingBody,
  ResourceSurfacePendingTitle,
} from "@/lib/resourceSurface/draftStore";

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

function materializePosition(
  surface: ResourceSurface,
  position: ResourceSurfaceDraftPosition,
): SurfacePosition | null {
  if (position.kind === "start") return { kind: "start" };
  const occurrence = resourceSurfaceOccurrenceForRef(
    surface,
    position.targetRef,
  );
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
}): ResourceSurfaceOccurrence {
  const ref = `note_block:${input.noteId}`;
  return {
    occurrenceId: `local:${input.noteId}`,
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

export function projectResourceSurfaceCommand(
  surface: ResourceSurface,
  command: ResourceSurfaceCommand,
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
    occurrenceId: `local:${command.targetRef}`,
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
  const occurrenceTargetRef = occurrenceId
    ? input.surface.orderedItems.find(
        (item) => item.occurrenceId === occurrenceId,
      )?.target.item.ref
    : undefined;
  const rawPosition =
    input.command.type === "insert_note" ||
    input.command.type === "insert_resource" ||
    input.command.type === "move_occurrence"
      ? input.command.position
      : undefined;
  const position: ResourceSurfaceDraftPosition | undefined =
    rawPosition?.kind === "after"
      ? (() => {
          const target = input.surface.orderedItems.find(
            (item) => item.occurrenceId === rawPosition.occurrenceId,
          );
          return target === undefined
            ? undefined
            : { kind: "after", targetRef: target.target.item.ref };
        })()
      : rawPosition;
  if (rawPosition?.kind === "after" && position === undefined) return null;
  if (occurrenceId !== undefined && occurrenceTargetRef === undefined) return null;
  return {
    clientMutationId: input.clientMutationId,
    command: input.command,
    occurrenceTargetRef,
    position,
  };
}

export function materializeResourceSurfaceIntent(
  surface: ResourceSurface,
  intent: ResourceSurfaceDraftIntent,
): ResourceSurfaceCommand | null {
  const occurrence = intent.occurrenceTargetRef
    ? resourceSurfaceOccurrenceForRef(surface, intent.occurrenceTargetRef)
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

export function projectResourceSurface(input: {
  acknowledgedSurface: ResourceSurface;
  intents: readonly ResourceSurfaceDraftIntent[];
  title: ResourceSurfacePendingTitle | undefined;
  bodies: ReadonlyMap<string, ResourceSurfacePendingBody>;
}): ResourceSurface {
  let surface = input.acknowledgedSurface;
  for (const intent of input.intents) {
    const command = materializeResourceSurfaceIntent(surface, intent);
    if (command !== null) {
      surface = projectResourceSurfaceCommand(surface, command);
    }
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
