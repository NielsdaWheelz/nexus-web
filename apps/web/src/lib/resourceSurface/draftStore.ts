import { decodeNoteBodyValue } from "@/lib/notes/prosemirror/schema";
import type { ResourceSurfaceCommand } from "@/lib/resourceSurface/model";
import type { ResourceSurface } from "@/lib/resources/resourceItems";

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
  try {
    const draft = JSON.parse(raw) as ResourceSurfaceDraft;
    if (draft.version !== 2 || draft.source_ref !== sourceRef) {
      throw new TypeError("resource surface draft does not match its key");
    }
    // Bodies mount in a ProseMirror editor, which cannot render invalid
    // document JSON.
    for (const [ref, body] of Object.entries(draft.bodies)) {
      decodeNoteBodyValue(
        body.body_pm_json,
        body.body_text,
        `resource surface draft.bodies.${ref}`,
      );
    }
    return draft;
  } catch {
    clearPersistedResourceSurfaceDraft(sourceRef);
    return null;
  }
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
