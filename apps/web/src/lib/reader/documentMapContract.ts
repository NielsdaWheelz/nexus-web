import { projectConnectionActivation } from "@/lib/resourceGraph/connections";
import type { Schema } from "@/lib/api/wire";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type {
  ReaderDocumentMap,
  ReaderEvidenceAssociation,
  ReaderEvidenceItem,
  ReaderEvidenceObject,
} from "./documentMap";

type WireItem = Schema<"ReaderEvidenceOut">["document_items"][number];
type WireObject = Schema<"ReaderEvidenceLinkOut">["object"];

function subject(ref: string): ResourceActionSubject {
  // justify-type-assertion: generated canonical resource refs regain their
  // product brand after JSON transport; no alternate wire shape is accepted.
  return { ref: ref as CanonicalResourceRef };
}

function projectObject(value: WireObject): ReaderEvidenceObject {
  return { ...value, activation: projectConnectionActivation(value.activation), actionSubject: subject(value.ref) };
}

function projectAssociation(value: Schema<"ReaderEvidenceLinkOut">["associations"][number]): ReaderEvidenceAssociation {
  return { ...value, object: projectObject(value.object) };
}

function projectItem(value: WireItem): ReaderEvidenceItem {
  const associations = value.associations.map(projectAssociation);
  switch (value.kind) {
    case "Highlight":
    case "GeneratedCitation":
    case "SourceReference": return { ...value, associations };
    case "Link":
    case "MachineLink": return { ...value, associations, object: projectObject(value.object) };
  }
}

/** Product identities are projected once from the generated same-deploy DTO. */
export function projectReaderDocumentMap(value: Schema<"ReaderDocumentMapOut">): ReaderDocumentMap {
  return {
    ...value,
    embeds: value.embeds,
    markers: value.markers,
    diagnostics: { omitted_item_counts: value.diagnostics.omitted_item_counts },
    evidence: {
      counts: value.evidence.counts,
      source_targets: value.evidence.source_targets.map((target) => ({ ...target, activation: projectConnectionActivation(target.activation), actionSubject: subject(target.ref), resolution: target.resolution })),
      document_items: value.evidence.document_items.map(projectItem),
      passage_groups: value.evidence.passage_groups.map((group) => ({
        ...group,
        resolution: group.resolution,
        items: group.items.map(projectItem),
        also_references: group.also_references.map((association) => ({ ...association, object: projectObject(association.object) })),
      })),
    },
  };
}
