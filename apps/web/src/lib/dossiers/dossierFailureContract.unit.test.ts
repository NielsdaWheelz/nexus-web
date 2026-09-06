import { describe, expect, it } from "vitest";

import { DOSSIER_BUILD_FAILURE_CODES } from "@/lib/dossiers/dossierControllerTypes";
import { dossierBuildFailureMessage } from "@/lib/dossiers/dossierErrorMessage";
import {
  decodeDossierBuildSummary,
  decodeFailureCode,
} from "@/lib/dossiers/dossierWire";
import { decodeDossierStreamEvent } from "@/lib/dossiers/eventDecoder";

const CURRENT_FAILURE_CODES = [
  "NoSourceMaterial",
  "InputsChanged",
  "DependencyProjectionFailed",
  "ContextTooLarge",
  "Auth",
  "Quota",
  "Timeout",
  "OutputLimit",
  "InvalidOutput",
  "PolicyViolation",
  "RuntimeUnavailable",
  "CapacityUnavailable",
  "DocumentValidationFailed",
  "CitationValidationFailed",
] as const;

const CURRENT_FAILURE_MESSAGES = {
  NoSourceMaterial: "There's nothing citable here yet to build a dossier from.",
  InputsChanged:
    "The underlying material changed while this was generating. Try again.",
  DependencyProjectionFailed:
    "A required source couldn't be prepared. Try again once it's ready.",
  ContextTooLarge: "There's too much source material to fit in one dossier.",
  Auth: "The generation service couldn't authenticate. Try again later.",
  Quota:
    "The generation service has reached its usage limit. Try again later.",
  Timeout: "Dossier generation took too long. Try again.",
  OutputLimit:
    "The generated dossier reached its output limit. Try a narrower instruction.",
  InvalidOutput:
    "The generated dossier wasn't in the required format. Try again.",
  PolicyViolation:
    "This dossier couldn't be generated under the current policy.",
  RuntimeUnavailable:
    "Dossier generation is temporarily unavailable. Try again later.",
  CapacityUnavailable: "Dossier generation is busy. Try again shortly.",
  DocumentValidationFailed:
    "The generated dossier couldn't be validated. Try again.",
  CitationValidationFailed:
    "The generated citations couldn't be verified. Try again.",
} as const satisfies Record<(typeof CURRENT_FAILURE_CODES)[number], string>;

const HISTORICAL_FAILURE_CODES = [
  "EntitlementDenied",
  "BudgetExceeded",
  "ProviderRefused",
  "ProviderIncomplete",
] as const;

const HISTORICAL_FAILURE_MESSAGES = {
  EntitlementDenied: "You don't have access to generate this dossier.",
  BudgetExceeded:
    "This generation exceeded its budget. Try a narrower instruction.",
  ProviderRefused: "The model declined to generate this dossier.",
  ProviderIncomplete: "The model returned an incomplete dossier. Try again.",
} as const satisfies Record<(typeof HISTORICAL_FAILURE_CODES)[number], string>;

const ABSENT = { kind: "Absent" } as const;

function decodeFailedEvent(
  failureCode: string,
  eventType: "Failed" | "HistoricalFailed" = "Failed",
) {
  const event = decodeDossierStreamEvent(eventType, {
    failure_code: failureCode,
    detail: ABSENT,
    support: ABSENT,
  });
  if (event.kind !== "Failed") {
    throw new Error(`Failed event decoded as ${event.kind}`);
  }
  return event.facts;
}

function decodePersistedFailure(failureCode: string) {
  const build = decodeDossierBuildSummary({
    handle: "artifact-build-handle",
    requester_user_id: ABSENT,
    instruction: ABSENT,
    created_at: "2026-08-25T12:00:00Z",
    execution: ABSENT,
    failure: {
      kind: "Present",
      value: {
        failure_code: failureCode,
        detail: ABSENT,
        support: ABSENT,
      },
    },
    cancellation: ABSENT,
    admitted_generation: ABSENT,
    capacity_pause: ABSENT,
  });
  if (build.failure.kind !== "Present") {
    throw new Error(`Persisted failure ${failureCode} decoded as absent`);
  }
  return build.failure.value;
}

describe("Dossier failure browser contract", () => {
  it("decodes and renders every current backend-written failure code", () => {
    expect(
      DOSSIER_BUILD_FAILURE_CODES,
      "browser current-write vocabulary drifted from the backend enum",
    ).toEqual(CURRENT_FAILURE_CODES);

    for (const code of CURRENT_FAILURE_CODES) {
      expect(
        decodeFailureCode(code),
        `current-write decoder rejected ${code}`,
      ).toBe(code);
      expect(
        decodeFailedEvent(code),
        `Failed SSE event rejected ${code}`,
      ).toEqual({
        failureCode: code,
        detail: ABSENT,
        support: ABSENT,
      });
      expect(
        dossierBuildFailureMessage(code),
        `failure copy missing for ${code}`,
      ).toBe(CURRENT_FAILURE_MESSAGES[code]);
    }
  });

  it("reads and renders historical failures without admitting them as current writes", () => {
    for (const code of HISTORICAL_FAILURE_CODES) {
      expect(
        () => decodeFailureCode(code),
        `current-write decoder admitted historical code ${code}`,
      ).toThrow("unknown current failure code");
      expect(
        decodePersistedFailure(code),
        `head snapshot rejected historical failure ${code}`,
      ).toEqual({ failureCode: code, detail: ABSENT, support: ABSENT });
      expect(
        decodeFailedEvent(code, "HistoricalFailed"),
        `tagged SSE replay rejected historical failure ${code}`,
      ).toEqual({ failureCode: code, detail: ABSENT, support: ABSENT });
      expect(
        () => decodeFailedEvent(code),
        `current Failed SSE event admitted historical failure ${code}`,
      ).toThrow("unknown current failure code");
      expect(
        dossierBuildFailureMessage(code),
        `historical failure copy missing for ${code}`,
      ).toBe(HISTORICAL_FAILURE_MESSAGES[code]);
    }
  });
});
