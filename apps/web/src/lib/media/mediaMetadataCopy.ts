/** Metadata operation presentation shared by imports, menus and media detail. */
import type { Schema } from "@/lib/api/wire";
import type { Line } from "@/components/feedback/stage";
import type { SettledMetadataOperation } from "@/lib/media/mediaMetadataOperations";

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
  memory_exhausted: "the update ran out of memory",
  execution_timeout: "the worker exceeded its time limit",
  invalid_configuration: "the model setup needs a repair",
  no_result: "that update found nothing to apply",
  superseded: "replaced by a newer update",
} satisfies Record<Schema<"MetadataFailureCode">, string>;

export function metadataOperationName(purpose: MetadataPurpose): string {
  return ({ title: "title generation", bibliography: "metadata update" } satisfies Record<MetadataPurpose, string>)[purpose];
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
      return title ? "title queued" : "metadata update queued";
    case "running":
      return title ? "generating title" : "updating metadata";
    case "recovering":
      return `recovering interrupted ${name}`;
    case "waiting":
      return operation.until !== null && formatTime !== undefined
        ? `${name} will retry ${formatTime(operation.until)}`
        : "waiting to retry";
    case "held":
      return `${name} needs a repair`;
    case "failed":
      return title ? "couldn't generate a title" : "metadata update failed";
    case "completed":
      if (operation.outcome.purpose === "title") {
        return operation.outcome.disposition === "generated"
          ? "title generated"
          : "used source label";
      }
      return operation.outcome.changed_fields.length === 0
        ? "metadata unchanged"
        : "metadata updated";
  }
}

export function metadataResearchLabel(
  operation: MetadataEnrichmentView["operation"],
  purpose: MetadataPurpose,
): string {
  if (purpose === "title") {
    if (operation === null || operation.purpose !== "title")
      return "generate title";
    return operation.status === "failed"
      ? "retry title generation"
      : "generate title again";
  }
  if (operation === null) return "update metadata";
  return operation.status === "failed"
    ? "retry metadata update"
    : "update metadata";
}

export function metadataRequestLine(title: string, purpose: MetadataPurpose): Line {
  return { fact: `requesting ${metadataOperationName(purpose)} for “${title}”…` };
}

export function metadataObservationLine(title: string, purpose: MetadataPurpose): Line {
  const subject = ({ title: "title generation", bibliography: "the metadata update" } satisfies Record<MetadataPurpose, string>)[purpose];
  return { fact: `couldn’t check ${subject} for “${title}”.` };
}

/** One deliberate terminal result. Field lists and unrecorded search belong in inspection. */
export function metadataResultLine(operation: SettledMetadataOperation | Extract<MetadataOperation, { status: "held" }>, title: string): Line {
  if (operation.status === "held") return {
    fact: `${metadataOperationName(operation.purpose)} needs a repair for “${title}”.`,
    reason: `${METADATA_FAILURE_COPY[operation.code]}.`,
  };
  if (operation.status === "failed") {
    const action = ({ title: "generate a title", bibliography: "update metadata" } satisfies Record<MetadataPurpose, string>)[operation.purpose];
    return { fact: `couldn’t ${action} for “${title}”.`, reason: `${METADATA_FAILURE_COPY[operation.code]}.` };
  }
  const outcome = operation.outcome;
  if (outcome.purpose === "title") return {
    fact: outcome.changed_fields.length === 0 ? `title unchanged for “${title}”.`
      : outcome.disposition === "generated" ? `generated a title for “${title}”.`
        : `restored the source label for “${title}”.`,
  };
  const fields = outcome.changed_fields;
  return { fact: fields.length > 0 ? `metadata updated for “${title}”.`
    : `metadata unchanged for “${title}”.` };
}

export const X_TITLE_CONTEXT_HELP =
  "titles use saved text and supplied image descriptions; images and external linked pages are not read for naming";

/** Coverage describes captured evidence, never an inferred complete thread. */
export function xSourceCoverage(context: Schema<"XSourceContext">): string {
  const limits = [
    context.limits.length > 0 ? "capture limit reached" : null,
    context.scope === "author_thread" && context.search_exhausted === null
      ? "thread discovery status unknown"
      : context.scope === "author_thread" && context.search_exhausted === false && context.limits.length === 0
        ? "thread discovery stopped early"
        : null,
    context.unresolved_parent_count > 0 ? "some reply connections could not be checked" : null,
    context.unchecked_post_count > 0
      ? `${context.unchecked_post_count} saved ${context.unchecked_post_count === 1 ? "post was" : "posts were"} not checked in this refresh`
      : null,
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
    latest !== null &&
    (latest.status === "queued" ||
      latest.status === "running" ||
      latest.status === "recovering" ||
      latest.status === "waiting" ||
      latest.status === "held");
  return view.unfinished_count - (latestUnfinished ? 1 : 0);
}
