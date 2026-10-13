/** Metadata research presentation shared by imports and media detail. */
import type { Schema } from "@/lib/api/wire";

type MetadataOperation = Schema<"MetadataOperationOut">;
type MetadataEnrichmentView = Schema<"MetadataEnrichmentView">;

export const METADATA_FIELD_LABELS = {
  title: "title",
  contributors: "contributors",
  original_published_date: "first publication",
  edition_published_date: "edition publication",
  edition_isbn: "isbn",
  publisher: "publisher",
  language: "language",
  description: "description",
} satisfies Record<Schema<"MetadataField">, string>;

export const METADATA_FAILURE_COPY = {
  model_unavailable:
    "metadata research is unavailable; the model or required tools could not run",
  authentication_failed: "the provider needs authentication",
  quota_unavailable: "the provider has no available quota",
  research_timeout: "metadata research timed out",
  invalid_output: "the research result was invalid and was not applied",
  input_too_large: "the identifying metadata exceeds the research input limit",
  output_limit: "the research result exceeded the output limit",
  stale_input: "research result was not applied; the source or credits changed",
  no_longer_eligible: "this item is no longer eligible for metadata research",
  access_revoked: "access changed; the research result was not applied",
  cancelled: "metadata research was cancelled",
  policy_violation: "the research request could not be executed",
  worker_interrupted: "metadata research was interrupted",
  execution_failed: "metadata research could not be completed",
} satisfies Record<Schema<"MetadataFailureCode">, string>;

export const METADATA_RETRY_BLOCKED_COPY = {
  not_creator: "only the creator can research metadata",
  not_eligible: "this item is not eligible for metadata research",
  active: "metadata research is already in progress",
} satisfies Record<Schema<"MetadataRetryBlocked">["reason"], string>;

export function metadataOperationSummary(
  operation: MetadataOperation,
  formatTime?: (value: string) => string,
): string {
  switch (operation.status) {
    case "queued":
      return "metadata research queued";
    case "running":
      return "researching metadata";
    case "recovering":
      return "recovering interrupted metadata research";
    case "waiting":
      return operation.until.kind === "Present" && formatTime !== undefined
        ? `metadata research will retry ${formatTime(operation.until.value)}`
        : "metadata research will retry";
    case "no_findings":
      return operation.reviewed_at.kind === "Present"
        ? "no metadata found · reviewed"
        : "no metadata found";
    case "failed":
      return "metadata research failed";
    case "completed":
      return operation.outcome.changed_fields.length === 0
        ? "metadata checked; no changes"
        : "metadata updated";
  }
}

export function metadataResearchLabel(
  operation: MetadataEnrichmentView["operation"],
): string {
  if (operation.kind === "Absent") return "research metadata";
  return operation.value.status === "failed"
    ? "retry metadata research"
    : "research again";
}

export function earlierMetadataRuns(view: MetadataEnrichmentView): number {
  const latest = view.operation;
  const latestUnfinished =
    latest.kind === "Present" &&
    (latest.value.status === "queued" ||
      latest.value.status === "running" ||
      latest.value.status === "recovering" ||
      latest.value.status === "waiting");
  return view.unfinished_count - (latestUnfinished ? 1 : 0);
}

export const METADATA_REVIEW_HELP =
  "removes this result from needs attention for you. it stays in history.";
