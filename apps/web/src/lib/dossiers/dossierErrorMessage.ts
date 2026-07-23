// One exhaustive error-copy boundary (A14) for every expected Dossier error,
// mapped near the screen. Two closed maps:
//   - `dossierBuildFailureMessage`: the async `DossierBuildFailureCode` union
//     (A7) that terminalizes a build (surfaced from the head's
//     `latest_unsuccessful_build` or a `Failed` stream event).
//   - `dossierApiErrorMessage`: the synchronous A9 API error union returned by
//     Generate/Cancel/Make-current/read (invalid subject, masked not-found,
//     generation-in-progress, invalid instruction, revision-not-found /
//     not-owned, build-not-active).
//
// The A9 errors are keyed by their dedicated `ApiError.code`; no legacy error
// aliases are accepted at this hard-cut boundary.
import { isApiError } from "@/lib/api/client";
import type {
  DossierBuildFailureCode,
  DossierErrorInfo,
} from "@/lib/dossiers/dossierControllerTypes";

export function dossierBuildFailureMessage(
  code: DossierBuildFailureCode,
): string {
  switch (code) {
    case "NoSourceMaterial":
      return "There's nothing citable here yet to build a dossier from.";
    case "InputsChanged":
      return "The underlying material changed while this was generating. Try again.";
    case "DependencyProjectionFailed":
      return "A required source couldn't be prepared. Try again once it's ready.";
    case "EntitlementDenied":
      return "You don't have access to generate this dossier.";
    case "BudgetExceeded":
      return "This generation exceeded its budget. Try a narrower instruction.";
    case "ContextTooLarge":
      return "There's too much source material to fit in one dossier.";
    case "ProviderRefused":
      return "The model declined to generate this dossier.";
    case "ProviderIncomplete":
      return "The model returned an incomplete dossier. Try again.";
    case "SchemaRepairExhausted":
      return "The generated dossier couldn't be validated. Try again.";
    case "CitationValidationFailed":
      return "The generated citations couldn't be verified. Try again.";
    case "MigratedFailure":
      return "This dossier failed before it was migrated. Regenerate to rebuild it.";
    case "MigratedIncomplete":
      return "This dossier was never completed before migration. Regenerate to build it.";
    default: {
      const exhaustive: never = code;
      throw new Error(`Unhandled dossier failure code: ${String(exhaustive)}`);
    }
  }
}

export const DOSSIER_API_ERROR_CODES = [
  "E_DOSSIER_GENERATION_IN_PROGRESS",
  "E_DOSSIER_BUILD_NOT_ACTIVE",
  "E_DOSSIER_NOT_FOUND",
  "E_DOSSIER_REVISION_NOT_FOUND",
  "E_DOSSIER_INVALID_SUBJECT",
  "E_DOSSIER_INVALID_INSTRUCTION",
] as const;

export type DossierApiErrorCode = (typeof DOSSIER_API_ERROR_CODES)[number];

export function isDossierApiErrorCode(
  value: string,
): value is DossierApiErrorCode {
  return (DOSSIER_API_ERROR_CODES as readonly string[]).includes(value);
}

function dossierExpectedApiErrorMessage(code: DossierApiErrorCode): string {
  switch (code) {
    case "E_DOSSIER_GENERATION_IN_PROGRESS":
      return "A dossier is already generating. Wait for it to finish.";
    case "E_DOSSIER_BUILD_NOT_ACTIVE":
      return "This generation already finished.";
    case "E_DOSSIER_NOT_FOUND":
      return "This dossier is no longer available.";
    case "E_DOSSIER_REVISION_NOT_FOUND":
      return "That revision is no longer available.";
    case "E_DOSSIER_INVALID_SUBJECT":
      return "This item can't have a dossier.";
    case "E_DOSSIER_INVALID_INSTRUCTION":
      return "That instruction can't be used.";
    default: {
      const exhaustive: never = code;
      throw new Error(`Unhandled Dossier API error code: ${String(exhaustive)}`);
    }
  }
}

/** Copy for a synchronous A9 API error. Prefers a dedicated `E_DOSSIER_*`
 * mapping, then the backend-authored message, then a generic fallback. */
export function dossierApiErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (isDossierApiErrorCode(error.code)) {
      return dossierExpectedApiErrorMessage(error.code);
    }
    if (error.message.trim().length > 0) return error.message;
    if (error.status === 404) return "This dossier is no longer available.";
    if (error.status === 409) return "This dossier can't be changed right now.";
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Something went wrong with this dossier. Try again.";
}

/** Decode any thrown transport error into the owned `DossierErrorInfo` the
 * controller state carries (so the view-model renders copy, not raw errors). */
export function toDossierErrorInfo(error: unknown): DossierErrorInfo {
  const code = isApiError(error) ? error.code : "E_UNKNOWN";
  return { code, message: dossierApiErrorMessage(error) };
}
