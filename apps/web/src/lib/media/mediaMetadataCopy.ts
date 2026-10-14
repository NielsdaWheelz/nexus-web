/** Metadata operation presentation shared by imports, menus and media detail. */
import type { Schema } from "@/lib/api/wire";

type MetadataOperation = Schema<"MetadataOperationOut">;
type MetadataEnrichmentView = Schema<"MetadataEnrichmentView">;
type MetadataPurpose = Schema<"MetadataRetryAllowed">["purpose"];

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
    "the configured model or required tools could not run",
  authentication_failed: "the provider needs authentication",
  quota_unavailable: "the provider has no available quota",
  research_timeout: "the operation timed out",
  invalid_output: "the result was invalid and was not applied",
  input_too_large: "the saved input exceeds the operation's input limit",
  output_limit: "the result exceeded the output limit",
  stale_input: "the result was not applied; the source or metadata changed",
  no_longer_eligible: "this item is no longer eligible for this operation",
  source_context_missing: "refresh source to generate a title",
  access_revoked: "access changed; the result was not applied",
  cancelled: "the operation was cancelled",
  policy_violation: "the request could not be executed",
  worker_interrupted: "the operation was interrupted",
  execution_failed: "the operation could not be completed",
} satisfies Record<Schema<"MetadataFailureCode">, string>;

export function metadataOperationName(purpose: MetadataPurpose): string {
  return purpose === "title" ? "title generation" : "metadata research";
}

export function metadataRetryBlockedCopy(
  retry: Schema<"MetadataRetryBlocked">,
): string {
  const name = metadataOperationName(retry.purpose);
  const copy = {
    not_creator: `only the creator can request ${name}`,
    not_eligible: `this item is not eligible for ${name}`,
    active: `${name} is already in progress`,
    source_context_missing: "refresh source to generate a title",
  } satisfies Record<Schema<"MetadataRetryBlocked">["reason"], string>;
  return copy[retry.reason];
}

export function metadataOperationSummary(
  operation: MetadataOperation,
  formatTime?: (value: string) => string,
): string {
  const title = operation.purpose === "title";
  const name = metadataOperationName(operation.purpose);
  switch (operation.status) {
    case "queued":
      return title ? "title queued" : "metadata research queued";
    case "running":
      return title ? "generating title" : "researching metadata";
    case "recovering":
      return `recovering interrupted ${name}`;
    case "waiting":
      return operation.until.kind === "Present" && formatTime !== undefined
        ? `${name} will retry ${formatTime(operation.until.value)}`
        : `${name} will retry`;
    case "no_findings":
      return operation.reviewed_at.kind === "Present"
        ? "no metadata found · reviewed"
        : "no metadata found";
    case "failed":
      return title ? "couldn't generate a title" : "metadata research failed";
    case "completed":
      if (operation.outcome.purpose === "title") {
        return operation.outcome.disposition === "generated"
          ? "title generated"
          : "used source label";
      }
      return operation.outcome.changed_fields.length === 0
        ? "metadata checked; no changes"
        : "metadata updated";
  }
}

export function metadataResearchLabel(
  operation: MetadataEnrichmentView["operation"],
  purpose: MetadataPurpose,
): string {
  if (purpose === "title") {
    if (operation.kind === "Absent" || operation.value.purpose !== "title")
      return "generate title";
    return operation.value.status === "failed"
      ? "retry title generation"
      : "generate title again";
  }
  if (operation.kind === "Absent") return "research metadata";
  return operation.value.status === "failed"
    ? "retry metadata research"
    : "research again";
}

export const X_TITLE_CONTEXT_HELP =
  "titles use saved text and supplied image descriptions; images and external linked pages are not read for naming";

/** Coverage describes captured evidence, never an inferred complete thread. */
export function xSourceCoverage(context: Schema<"XSourceContext">): string {
  const limits = [
    context.enumeration === "post_limit" ? "thread capture limited" : null,
    context.unavailable_context_count > 0
      ? `${context.unavailable_context_count} referenced ${context.unavailable_context_count === 1 ? "post" : "posts"} unavailable`
      : null,
    context.uncaptured_context_count > 0
      ? `some context not captured (${context.uncaptured_context_count} referenced ${context.uncaptured_context_count === 1 ? "post" : "posts"})`
      : null,
  ].filter((value) => value !== null);
  return limits.length > 0 ? limits.join(" · ") : "no recorded capture limits";
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
