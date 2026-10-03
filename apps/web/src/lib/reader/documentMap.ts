import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { absent, present, type Presence } from "@/lib/api/presence";
import type { ResourceActivation } from "@/lib/resources/activation";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";

export type ReaderEvidenceFactKind = ReaderEvidenceItem["kind"];
export type ReaderEvidenceSemanticKind =
  "highlight" | "citation" | "link" | "synapse";
export type ReaderEvidenceResolution = Schema<"ReaderEvidencePassageGroupOut">["resolution"];
export type ReaderEvidenceSourceContent = Schema<"ReaderEvidenceSourceTargetOut">["content"];
export interface ReaderEvidenceSourceActivation {
  occurrenceItemId: string | null;
  targetRef: string;
}

type WithActivation<T> = Omit<T, "activation"> & {
  activation: ResourceActivation;
  actionSubject: ResourceActionSubject;
};
export type ReaderEvidenceNoteObject = WithActivation<Schema<"ReaderEvidenceNoteObjectOut">>;
export type ReaderEvidenceObject =
  | WithActivation<Schema<"ReaderEvidenceChatObjectOut">>
  | ReaderEvidenceNoteObject
  | WithActivation<Schema<"ReaderEvidencePlainObjectOut">>;
export type ReaderEvidenceSourceTarget = WithActivation<Schema<"ReaderEvidenceSourceTargetOut">>;
export type ReaderEvidenceDirectlyAttachedAssociation =
  Omit<Schema<"ReaderEvidenceDirectlyAttachedOut">, "object"> & {
    object: ReaderEvidenceObject;
  };
export type ReaderEvidenceAssociation =
  | (Omit<Schema<"ReaderEvidenceAuthoredInOut">, "object"> & { object: ReaderEvidenceObject })
  | ReaderEvidenceDirectlyAttachedAssociation;
export type ReaderEvidenceAlsoReference =
  Omit<Schema<"ReaderEvidenceAlsoReferenceOut">, "object"> & {
    object: ReaderEvidenceObject;
  };
export type ReaderEvidenceHighlightNoteAssociation = ReaderEvidenceDirectlyAttachedAssociation & {
  origin: "highlight_note";
  direction: "Outgoing";
  object: ReaderEvidenceNoteObject;
};
export type ReaderEvidenceUserStanceAssociation = ReaderEvidenceDirectlyAttachedAssociation & {
  origin: "user";
  direction: "Outgoing";
  role: "supports" | "contradicts";
};
type WithAssociations<T> = Omit<T, "associations"> & { associations: ReaderEvidenceAssociation[] };
export type ReaderEvidenceHighlight = WithAssociations<Schema<"ReaderEvidenceHighlightOut">>;
export type ReaderEvidenceSourceReference = WithAssociations<Schema<"ReaderEvidenceSourceReferenceOut">>;
export type ReaderEvidenceLink =
  Omit<WithAssociations<Schema<"ReaderEvidenceLinkOut">>, "object"> & {
    object: ReaderEvidenceObject;
  };
export type ReaderEvidenceItem =
  | ReaderEvidenceHighlight
  | ReaderEvidenceSourceReference
  | WithAssociations<Schema<"ReaderEvidenceGeneratedCitationOut">>
  | ReaderEvidenceLink
  | (Omit<WithAssociations<Schema<"ReaderEvidenceSynapseOut">>, "object"> & { object: ReaderEvidenceObject });
export type ReaderEvidenceUserLink = ReaderEvidenceLink & { origin: "user" };
export type ReaderEvidenceUserAssociation = ReaderEvidenceDirectlyAttachedAssociation & { origin: "user" };
export type ReaderEvidenceUserEdge = ReaderEvidenceUserLink | ReaderEvidenceUserAssociation;
export type ReaderEvidencePassageGroup = Omit<Schema<"ReaderEvidencePassageGroupOut">, "items" | "also_references"> & {
  items: ReaderEvidenceItem[];
  also_references: ReaderEvidenceAlsoReference[];
};
export type ReaderEvidence = Omit<Schema<"ReaderEvidenceOut">, "source_targets" | "passage_groups" | "document_items"> & {
  source_targets: ReaderEvidenceSourceTarget[];
  passage_groups: ReaderEvidencePassageGroup[];
  document_items: ReaderEvidenceItem[];
};
export type ReaderDocumentMapMarker = Schema<"ReaderDocumentMapMarkerOut">;
export type ReaderDocumentMapMarkerKind = ReaderDocumentMapMarker["kind"];
export type ReaderDocumentMap = Omit<Schema<"ReaderDocumentMapOut">, "evidence"> & { evidence: ReaderEvidence };

export type ReaderMapContent =
  | {
      kind: "Highlight";
      quote: Presence<string>;
      notes: readonly {
        noteBlockId: string;
        excerpt: Presence<string>;
      }[];
    }
  | {
      kind: "Named";
      label: string;
      excerpt: Presence<string>;
    };

export interface ReaderMapMarkerPresentation {
  marker: ReaderDocumentMapMarker;
  content: ReaderMapContent;
}

export type ReaderEvidenceItemLocation =
  | {
      scope: "passage";
      item: ReaderEvidenceItem;
      group: ReaderEvidencePassageGroup;
    }
  | {
      scope: "document";
      item: ReaderEvidenceItem;
    };

export function semanticKindForEvidenceItem(
  item: ReaderEvidenceItem,
): ReaderEvidenceSemanticKind {
  switch (item.kind) {
    case "Highlight":
      return "highlight";
    case "SourceReference":
    case "GeneratedCitation":
      return "citation";
    case "Link":
      return "link";
    case "Synapse":
      return "synapse";
  }
}

export function highlightNoteAssociations(
  item: ReaderEvidenceHighlight,
): ReaderEvidenceHighlightNoteAssociation[] {
  return item.associations.filter(
    (association): association is ReaderEvidenceHighlightNoteAssociation =>
      association.relationship === "DirectlyAttached" &&
      association.origin === "highlight_note" &&
      association.direction === "Outgoing" &&
      association.object.kind === "Note",
  );
}

export function userStanceAssociations(
  item: ReaderEvidenceHighlight,
): ReaderEvidenceUserStanceAssociation[] {
  return item.associations.filter(
    (association): association is ReaderEvidenceUserStanceAssociation =>
      association.relationship === "DirectlyAttached" &&
      association.origin === "user" &&
      association.direction === "Outgoing" &&
      (association.role === "supports" || association.role === "contradicts"),
  );
}

export function isReaderEvidenceUserLink(
  item: ReaderEvidenceItem,
): item is ReaderEvidenceUserLink {
  return item.kind === "Link" && item.origin === "user";
}

export function isReaderEvidenceUserAssociation(
  association: ReaderEvidenceAssociation | ReaderEvidenceAlsoReference,
): association is ReaderEvidenceUserAssociation {
  return (
    association.relationship === "DirectlyAttached" &&
    association.origin === "user"
  );
}

export function findEvidenceItem(
  evidence: ReaderEvidence,
  itemId: string,
): ReaderEvidenceItemLocation | null {
  for (const group of evidence.passage_groups) {
    const item = group.items.find((candidate) => candidate.id === itemId);
    if (item) return { scope: "passage", item, group };
  }
  const item = evidence.document_items.find(
    (candidate) => candidate.id === itemId,
  );
  return item ? { scope: "document", item } : null;
}

export function projectReaderMapMarkers(
  map: ReaderDocumentMap,
): readonly ReaderMapMarkerPresentation[] {
  return map.markers.map((marker): ReaderMapMarkerPresentation => {
    if (marker.kind !== "Highlight") {
      return {
        marker,
        content: {
          kind: "Named",
          label: marker.label,
          excerpt: marker.preview,
        },
      };
    }

    const location = findEvidenceItem(map.evidence, marker.item_id);
    if (
      location === null ||
      location.scope !== "passage" ||
      location.item.kind !== "Highlight" ||
      location.group.resolution.kind !== "Resolved"
    ) {
      // justify-defect: a positioned highlight marker must reference its own
      // resolved passage fact in the same aggregate.
      throw new Error(
        `Highlight map marker ${marker.id} has no resolved passage highlight.`,
      );
    }

    return {
      marker,
      content: {
        kind: "Highlight",
        quote: location.item.quote.trim() ? present(location.item.quote) : absent(),
        notes: highlightNoteAssociations(location.item).map(({ object }) => ({
          noteBlockId: object.note_block_id,
          excerpt:
            object.excerpt.kind === "Present" && object.excerpt.value.trim()
              ? object.excerpt
              : absent(),
        })),
      },
    };
  });
}

function adaptObject(
  value: Schema<"ReaderEvidenceChatObjectOut">
    | Schema<"ReaderEvidenceNoteObjectOut">
    | Schema<"ReaderEvidencePlainObjectOut">,
): ReaderEvidenceObject {
  return {
    ...value,
    actionSubject: { ref: assumeCanonicalResourceRef(value.ref) },
  };
}

function adaptAssociation(
  value: Schema<"ReaderEvidenceAuthoredInOut"> | Schema<"ReaderEvidenceDirectlyAttachedOut">,
): ReaderEvidenceAssociation {
  return { ...value, object: adaptObject(value.object) };
}

function adaptItem(
  value: Schema<"ReaderEvidencePassageGroupOut">["items"][number],
): ReaderEvidenceItem {
  const associations = value.associations.map(adaptAssociation);
  if (value.kind === "Link" || value.kind === "Synapse") {
    return { ...value, associations, object: adaptObject(value.object) };
  }
  return { ...value, associations };
}

export async function getReaderDocumentMap(
  mediaId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ReaderDocumentMap> {
  const { data } = await apiFetch<ApiJson<"/media/{media_id}/document-map", "get">>(
    `/api/media/${mediaId}/document-map`,
    { signal: options.signal },
  );
  return {
    ...data,
    evidence: {
      ...data.evidence,
      source_targets: data.evidence.source_targets.map((target) => ({
        ...target,
        actionSubject: { ref: assumeCanonicalResourceRef(target.ref) },
      })),
      passage_groups: data.evidence.passage_groups.map((group) => ({
        ...group,
        items: group.items.map(adaptItem),
        also_references: group.also_references.map((association) => ({
          ...association,
          object: adaptObject(association.object),
        })),
      })),
      document_items: data.evidence.document_items.map(adaptItem),
    },
  };
}
