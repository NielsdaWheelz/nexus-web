import {
  decodeNoteBodyPmJson,
  decodeNoteBodyValue,
} from "@/lib/notes/prosemirror/schema";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import type { ResourceSurfaceCommand } from "@/lib/resourceSurface/model";
import {
  decodeResourceSurfaceSnapshot,
  type ResourceSurface,
  type SurfacePosition,
} from "@/lib/resources/resourceItems";
import {
  expectArray,
  expectCanonicalUuid,
  expectExactRecord,
  expectRecord,
  expectString,
} from "@/lib/validation";

const STORAGE_PREFIX = "nexus.resourceSurface:";

export type ResourceSurfaceOccurrenceAnchor =
  | { kind: "persisted"; occurrenceId: string }
  | { kind: "pending"; clientMutationId: string };

export type ResourceSurfaceDraftPosition =
  | { kind: "start" }
  | { kind: "after"; anchor: ResourceSurfaceOccurrenceAnchor };

export type ResourceSurfaceDraftIntent = {
  clientMutationId: string;
  command: ResourceSurfaceCommand;
  occurrenceAnchor?: ResourceSurfaceOccurrenceAnchor;
  position?: ResourceSurfaceDraftPosition;
};

export type ResourceSurfacePendingTitle = {
  value: string;
  clientMutationId: string;
};

export type ResourceSurfacePendingBody = {
  bodyPmJson: Record<string, unknown>;
  bodyText: string;
  clientMutationId: string;
};

export type ResourceSurfaceDraft = {
  version: 2;
  source_ref: string;
  acknowledged_surface: ResourceSurface;
  commands: ResourceSurfaceDraftIntent[];
  title?: {
    value: string;
    client_mutation_id: string;
  };
  bodies: Record<
    string,
    {
      body_pm_json: Record<string, unknown>;
      body_text: string;
      client_mutation_id: string;
    }
  >;
};

function expectResourceRef(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (parseResourceRef(value) === null) {
    throw new TypeError(`${name} must be a canonical ResourceRef`);
  }
  return value;
}

function expectOccurrenceLocator(raw: unknown, name: string): string {
  const value = expectString(raw, name);
  if (value.startsWith("pending:")) {
    expectCanonicalUuid(value.slice("pending:".length), `${name} pending ID`);
    return value;
  }
  return expectCanonicalUuid(value, name);
}

function decodeOccurrenceAnchor(
  raw: unknown,
  name: string,
): ResourceSurfaceOccurrenceAnchor {
  const record = expectRecord(raw, name);
  switch (expectString(record.kind, `${name}.kind`)) {
    case "persisted": {
      const anchor = expectExactRecord(raw, ["kind", "occurrenceId"], name);
      return {
        kind: "persisted",
        occurrenceId: expectCanonicalUuid(
          anchor.occurrenceId,
          `${name}.occurrenceId`,
        ),
      };
    }
    case "pending": {
      const anchor = expectExactRecord(
        raw,
        ["kind", "clientMutationId"],
        name,
      );
      return {
        kind: "pending",
        clientMutationId: expectCanonicalUuid(
          anchor.clientMutationId,
          `${name}.clientMutationId`,
        ),
      };
    }
    default:
      throw new TypeError(`${name}.kind is invalid`);
  }
}

function decodeSurfacePosition(raw: unknown, name: string): SurfacePosition {
  const record = expectRecord(raw, name);
  switch (expectString(record.kind, `${name}.kind`)) {
    case "start":
      expectExactRecord(raw, ["kind"], name);
      return { kind: "start" };
    case "after": {
      const position = expectExactRecord(raw, ["kind", "occurrenceId"], name);
      return {
        kind: "after",
        occurrenceId: expectOccurrenceLocator(
          position.occurrenceId,
          `${name}.occurrenceId`,
        ),
      };
    }
    default:
      throw new TypeError(`${name}.kind is invalid`);
  }
}

function decodeDraftPosition(
  raw: unknown,
  name: string,
): ResourceSurfaceDraftPosition {
  const record = expectRecord(raw, name);
  switch (expectString(record.kind, `${name}.kind`)) {
    case "start":
      expectExactRecord(raw, ["kind"], name);
      return { kind: "start" };
    case "after": {
      const position = expectExactRecord(raw, ["kind", "anchor"], name);
      return {
        kind: "after",
        anchor: decodeOccurrenceAnchor(position.anchor, `${name}.anchor`),
      };
    }
    default:
      throw new TypeError(`${name}.kind is invalid`);
  }
}

function decodeCommand(raw: unknown): ResourceSurfaceCommand {
  const record = expectRecord(raw, "resource surface draft command");
  switch (expectString(record.type, "resource surface draft command.type")) {
    case "insert_note": {
      const command = expectExactRecord(
        raw,
        ["type", "noteId", "position", "bodyPmJson"],
        "resource surface draft insert_note command",
      );
      return {
        type: "insert_note",
        noteId: expectCanonicalUuid(
          command.noteId,
          "resource surface draft insert_note command.noteId",
        ),
        position: decodeSurfacePosition(
          command.position,
          "resource surface draft insert_note command.position",
        ),
        bodyPmJson: decodeNoteBodyPmJson(
          command.bodyPmJson,
          "resource surface draft insert_note command.bodyPmJson",
        ),
      };
    }
    case "split_note": {
      const command = expectExactRecord(
        raw,
        [
          "type",
          "occurrenceId",
          "noteId",
          "leftBodyPmJson",
          "rightBodyPmJson",
        ],
        "resource surface draft split_note command",
      );
      return {
        type: "split_note",
        occurrenceId: expectOccurrenceLocator(
          command.occurrenceId,
          "resource surface draft split_note command.occurrenceId",
        ),
        noteId: expectCanonicalUuid(
          command.noteId,
          "resource surface draft split_note command.noteId",
        ),
        leftBodyPmJson: decodeNoteBodyPmJson(
          command.leftBodyPmJson,
          "resource surface draft split_note command.leftBodyPmJson",
        ),
        rightBodyPmJson: decodeNoteBodyPmJson(
          command.rightBodyPmJson,
          "resource surface draft split_note command.rightBodyPmJson",
        ),
      };
    }
    case "insert_resource": {
      const command = expectExactRecord(
        raw,
        ["type", "targetRef", "position"],
        "resource surface draft insert_resource command",
      );
      return {
        type: "insert_resource",
        targetRef: expectResourceRef(
          command.targetRef,
          "resource surface draft insert_resource command.targetRef",
        ),
        position: decodeSurfacePosition(
          command.position,
          "resource surface draft insert_resource command.position",
        ),
      };
    }
    case "move_occurrence": {
      const command = expectExactRecord(
        raw,
        ["type", "occurrenceId", "position"],
        "resource surface draft move_occurrence command",
      );
      return {
        type: "move_occurrence",
        occurrenceId: expectOccurrenceLocator(
          command.occurrenceId,
          "resource surface draft move_occurrence command.occurrenceId",
        ),
        position: decodeSurfacePosition(
          command.position,
          "resource surface draft move_occurrence command.position",
        ),
      };
    }
    case "remove_occurrence": {
      const command = expectExactRecord(
        raw,
        ["type", "occurrenceId"],
        "resource surface draft remove_occurrence command",
      );
      return {
        type: "remove_occurrence",
        occurrenceId: expectOccurrenceLocator(
          command.occurrenceId,
          "resource surface draft remove_occurrence command.occurrenceId",
        ),
      };
    }
    default:
      throw new TypeError("resource surface draft command.type is invalid");
  }
}

function decodeIntent(raw: unknown, index: number): ResourceSurfaceDraftIntent {
  const command = decodeCommand(
    expectRecord(raw, `resource surface draft.commands[${index}]`).command,
  );
  const name = `resource surface draft.commands[${index}]`;
  const clientMutationId = expectCanonicalUuid(
    expectRecord(raw, name).clientMutationId,
    `${name}.clientMutationId`,
  );
  switch (command.type) {
    case "insert_note":
    case "insert_resource": {
      const intent = expectExactRecord(
        raw,
        ["clientMutationId", "command", "position"],
        name,
      );
      return {
        clientMutationId,
        command,
        position: decodeDraftPosition(intent.position, `${name}.position`),
      };
    }
    case "move_occurrence": {
      const intent = expectExactRecord(
        raw,
        ["clientMutationId", "command", "occurrenceAnchor", "position"],
        name,
      );
      return {
        clientMutationId,
        command,
        occurrenceAnchor: decodeOccurrenceAnchor(
          intent.occurrenceAnchor,
          `${name}.occurrenceAnchor`,
        ),
        position: decodeDraftPosition(intent.position, `${name}.position`),
      };
    }
    case "remove_occurrence":
    case "split_note": {
      const intent = expectExactRecord(
        raw,
        ["clientMutationId", "command", "occurrenceAnchor"],
        name,
      );
      return {
        clientMutationId,
        command,
        occurrenceAnchor: decodeOccurrenceAnchor(
          intent.occurrenceAnchor,
          `${name}.occurrenceAnchor`,
        ),
      };
    }
  }
}

function decodeAcknowledgedSurface(raw: unknown): ResourceSurface {
  const surface = decodeResourceSurfaceSnapshot(raw);
  const decodeNode = (node: ResourceSurface["source"]) =>
    node.content.kind === "note_body"
      ? {
          ...node,
          content: {
            kind: "note_body" as const,
            ...decodeNoteBodyValue(
              node.content.bodyPmJson,
              node.content.bodyText,
              `resource surface draft body ${node.item.ref}`,
            ),
          },
        }
      : node;
  return {
    source: decodeNode(surface.source),
    orderedItems: surface.orderedItems.map((occurrence) => ({
      ...occurrence,
      target: decodeNode(occurrence.target),
    })),
  };
}

export function decodeResourceSurfaceDraft(
  raw: unknown,
  expectedSourceRef: string,
): ResourceSurfaceDraft {
  const record = expectRecord(raw, "resource surface draft");
  const hasTitle = Object.prototype.hasOwnProperty.call(record, "title");
  const draft = expectExactRecord(
    raw,
    hasTitle
      ? [
          "version",
          "source_ref",
          "acknowledged_surface",
          "commands",
          "title",
          "bodies",
        ]
      : [
          "version",
          "source_ref",
          "acknowledged_surface",
          "commands",
          "bodies",
        ],
    "resource surface draft",
  );
  if (draft.version !== 2) {
    throw new TypeError("resource surface draft.version must be 2");
  }
  const sourceRef = expectResourceRef(
    draft.source_ref,
    "resource surface draft.source_ref",
  );
  if (sourceRef !== expectedSourceRef) {
    throw new TypeError("resource surface draft.source_ref must match its key");
  }
  const acknowledgedSurface = decodeAcknowledgedSurface(
    draft.acknowledged_surface,
  );
  if (acknowledgedSurface.source.item.ref !== sourceRef) {
    throw new TypeError(
      "resource surface draft acknowledged source must match source_ref",
    );
  }
  const bodiesRecord = expectRecord(
    draft.bodies,
    "resource surface draft.bodies",
  );
  const bodies = Object.fromEntries(
    Object.entries(bodiesRecord).map(([ref, rawBody]) => {
      expectResourceRef(ref, "resource surface draft body ref");
      const body = expectExactRecord(
        rawBody,
        ["body_pm_json", "body_text", "client_mutation_id"],
        `resource surface draft.bodies.${ref}`,
      );
      const value = decodeNoteBodyValue(
        body.body_pm_json,
        body.body_text,
        `resource surface draft.bodies.${ref}`,
      );
      return [
        ref,
        {
          body_pm_json: value.bodyPmJson,
          body_text: value.bodyText,
          client_mutation_id: expectCanonicalUuid(
            body.client_mutation_id,
            `resource surface draft.bodies.${ref}.client_mutation_id`,
          ),
        },
      ];
    }),
  );
  let title: ResourceSurfaceDraft["title"];
  if (hasTitle) {
    const titleRecord = expectExactRecord(
      draft.title,
      ["value", "client_mutation_id"],
      "resource surface draft.title",
    );
    title = {
      value: expectString(
        titleRecord.value,
        "resource surface draft.title.value",
      ),
      client_mutation_id: expectCanonicalUuid(
        titleRecord.client_mutation_id,
        "resource surface draft.title.client_mutation_id",
      ),
    };
  }
  return {
    version: 2,
    source_ref: sourceRef,
    acknowledged_surface: acknowledgedSurface,
    commands: expectArray(
      draft.commands,
      decodeIntent,
      "resource surface draft.commands",
    ),
    ...(title === undefined ? {} : { title }),
    bodies,
  };
}

export function resourceSurfaceDraftStorageKey(sourceRef: string): string {
  return `${STORAGE_PREFIX}${sourceRef}`;
}

export function readResourceSurfaceDraft(
  sourceRef: string,
): ResourceSurfaceDraft | null {
  const raw = window.localStorage.getItem(
    resourceSurfaceDraftStorageKey(sourceRef),
  );
  if (raw === null) return null;
  return decodeResourceSurfaceDraft(JSON.parse(raw) as unknown, sourceRef);
}

export function pendingResourceSurfaceBodies(
  draft: ResourceSurfaceDraft | null,
): Map<string, ResourceSurfacePendingBody> {
  return new Map(
    Object.entries(draft?.bodies ?? {}).map(([ref, body]) => [
      ref,
      {
        bodyPmJson: body.body_pm_json,
        bodyText: body.body_text,
        clientMutationId: body.client_mutation_id,
      },
    ]),
  );
}

export function persistResourceSurfaceDraft(input: {
  sourceRef: string;
  acknowledgedSurface: ResourceSurface;
  commands: ResourceSurfaceDraftIntent[];
  title: ResourceSurfacePendingTitle | undefined;
  bodies: Map<string, ResourceSurfacePendingBody>;
  omittedBodyRef?: string;
}): boolean {
  const bodies: ResourceSurfaceDraft["bodies"] = {};
  for (const [ref, body] of input.bodies) {
    if (ref === input.omittedBodyRef) continue;
    bodies[ref] = {
      body_pm_json: body.bodyPmJson,
      body_text: body.bodyText,
      client_mutation_id: body.clientMutationId,
    };
  }
  const hasPending =
    input.commands.length > 0 ||
    input.title !== undefined ||
    Object.keys(bodies).length > 0;
  if (!hasPending) {
    try {
      window.localStorage.removeItem(
        resourceSurfaceDraftStorageKey(input.sourceRef),
      );
    } catch {
      // Local recovery may be unavailable; there is no durable row to clear.
    }
    return false;
  }
  const serialized = JSON.stringify({
    version: 2,
    source_ref: input.sourceRef,
    acknowledged_surface: input.acknowledgedSurface,
    commands: input.commands,
    ...(input.title === undefined
      ? {}
      : {
          title: {
            value: input.title.value,
            client_mutation_id: input.title.clientMutationId,
          },
        }),
    bodies,
  } satisfies ResourceSurfaceDraft);
  try {
    window.localStorage.setItem(
      resourceSurfaceDraftStorageKey(input.sourceRef),
      serialized,
    );
  } catch {
    // Local recovery may be unavailable; the owning network save continues.
  }
  return hasPending;
}

export function clearPersistedResourceSurfaceDraft(sourceRef: string): void {
  try {
    window.localStorage.removeItem(resourceSurfaceDraftStorageKey(sourceRef));
  } catch {
    // Local recovery may be unavailable; there is no durable row to clear.
  }
}
