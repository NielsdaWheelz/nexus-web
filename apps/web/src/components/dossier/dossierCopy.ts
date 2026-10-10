// Every dossier string that names a server fact: the failure codes, the
// command errors and the coverage line.
import { isApiError } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import { pluralize } from "@/lib/text/pluralize";

export const FAILURE_COPY: Record<Schema<"DossierFailureCode">, string> = {
  NoSourceMaterial: "There's nothing citable here yet to build a dossier from.",
  InputsChanged:
    "The underlying material changed while this was generating. Try again.",
  DependencyProjectionFailed:
    "A required source couldn't be prepared. Try again once it's ready.",
  ContextTooLarge: "There's too much source material to fit in one dossier.",
  Auth: "The generation service couldn't authenticate. Try again later.",
  Quota: "The generation service has reached its usage limit. Try again later.",
  Timeout: "Dossier generation took too long. Try again.",
  OutputLimit:
    "The generated dossier reached its output limit. Try a narrower instruction.",
  InvalidOutput:
    "The generated dossier wasn't in the required format. Try again.",
  PolicyViolation:
    "This dossier couldn't be generated under the current policy.",
  RuntimeUnavailable:
    "Dossier generation is temporarily unavailable. Try again later.",
  DocumentValidationFailed:
    "The generated dossier couldn't be validated. Try again.",
  CitationValidationFailed:
    "The generated citations couldn't be verified. Try again.",
};

const API_ERROR_COPY: Partial<Record<string, string>> = {
  E_DOSSIER_GENERATION_IN_PROGRESS:
    "A dossier is already generating. Wait for it to finish.",
  E_DOSSIER_BUILD_NOT_ACTIVE: "This generation already finished.",
  E_DOSSIER_NOT_FOUND: "This dossier is no longer available.",
  E_DOSSIER_INVALID_SUBJECT: "This item can't have a dossier.",
  E_DOSSIER_INVALID_INSTRUCTION: "That instruction can't be used.",
};

export function apiErrorCopy(error: unknown): string {
  return (
    (isApiError(error) &&
      (API_ERROR_COPY[error.code] ?? error.message.trim())) ||
    "Something went wrong with this dossier. Try again."
  );
}

/** `unit` is a singular noun; "media" is its own plural. */
export function coverageLabel({
  unit,
  included,
  omitted,
}: Schema<"DossierRevisionOut">["coverage"]): string {
  const counted = pluralize(
    included,
    unit,
    unit === "media" ? unit : undefined,
  );
  return `${counted} included · ${omitted} omitted`;
}
