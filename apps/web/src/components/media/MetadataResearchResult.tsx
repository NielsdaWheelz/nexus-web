import type { MetadataOperation } from "@/lib/media/mediaMetadataOperations";
import { METADATA_FIELD_LABELS } from "@/lib/media/mediaMetadataCopy";

/** The recorded result belongs to this run, including its captured source title. */
export default function MetadataResearchResult({ operation }: { readonly operation: MetadataOperation | null }) {
  const outcome = operation?.status === "completed" && operation.outcome.purpose === "bibliography" ? operation.outcome : null;
  const report = outcome?.container_report ?? (operation?.status === "no_findings" ? operation.container_report : null);
  return <>
    {outcome && outcome.changed_fields.length > 0 ? <p>changed by this run: {outcome.changed_fields.map(field => METADATA_FIELD_LABELS[field]).join(", ")}</p> : null}
    {outcome && outcome.unresolved_fields.length > 0 ? <p>not established by this run: {outcome.unresolved_fields.map(field => METADATA_FIELD_LABELS[field]).join(", ")}</p> : null}
    {report ? <section>
      <h4>source discrepancies reported by this run</h4>
      <p dir="auto">{report.source_title}</p>
      <ul>{report.discrepancies.map(item => <li key={item.field}><strong>{METADATA_FIELD_LABELS[item.field]}:</strong> {item.explanation}</li>)}</ul>
      <p>source metadata was not changed.</p>
    </section> : null}
  </>;
}
