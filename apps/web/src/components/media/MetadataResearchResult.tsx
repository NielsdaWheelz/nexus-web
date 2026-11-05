import type { MetadataOperation } from "@/lib/media/mediaMetadataOperations";
import { METADATA_FIELD_LABELS } from "@/lib/media/mediaMetadataCopy";

/** This run reports only the fields its atomic publication changed. */
export default function MetadataResearchResult({ operation }: { readonly operation: MetadataOperation | null }) {
  if (operation?.status !== "completed" || operation.outcome.purpose !== "bibliography") return null;
  const fields = operation.outcome.changed_fields;
  return <p>{fields.length === 0 ? "metadata unchanged" : `changed: ${fields.map(field => METADATA_FIELD_LABELS[field]).join(", ")}`}</p>;
}
