// Strict decoder for the artifact-build SSE stream
// (`GET /stream/artifact-builds/{handle}/events`, A9). The backend cursor
// tailer (`api/routes/_sse.py::format_sse_event`) emits one frame per persisted
// `ArtifactBuildEvent` as `event: <event_type>` + `data: <payload>` + `id: <seq>`,
// so the SSE `type` IS the `ArtifactBuildEventType` and `data` is the exact
// `dossier_types` payload (A5 §678). The stream MAY also emit an unsequenced
// `ExecutionAdvisory{phase}` (A5 §692) that never advances the cursor.
//
// Every payload is validated strictly (json-values.md): a malformed persisted
// event throws so the SSE client surfaces a stream error rather than dropping a
// load-bearing Delta/Succeeded/Failed. Unknown event types also throw (loud, per
// house `Unknown SSE event type` convention).
import { isRecord } from "@/lib/validation";
import { decodePresence } from "@/lib/api/presence";
import {
  decodeFailureCode,
} from "@/lib/dossiers/dossierWire";
import type {
  DossierCancelledFacts,
  DossierExecutionPhase,
  DossierFailedFacts,
} from "@/lib/dossiers/dossierControllerTypes";

/** SSE `event:` type for the unsequenced execution advisory. SEAM: this MUST
 * match the string the backend artifact-build stream route emits for the
 * queue/coordination advisory frame (not yet landed at authoring time). */
export const DOSSIER_ADVISORY_EVENT_TYPE = "ExecutionAdvisory";

export interface DossierSubjectLocatorWire {
  kind: "Resource" | "Contributor";
  ref?: string;
  handle?: string;
}

export type DossierStreamEvent =
  | {
      kind: "Started";
      buildHandle: string;
      artifactRef: string;
      subjectLocator: DossierSubjectLocatorWire;
    }
  | { kind: "Progress"; phase: string; message: string }
  | { kind: "Delta"; appendedText: string }
  | { kind: "Succeeded"; artifactRevisionRef: string }
  | { kind: "Failed"; facts: DossierFailedFacts }
  | { kind: "Cancelled"; facts: DossierCancelledFacts }
  | { kind: "Advisory"; phase: DossierExecutionPhase };

function fail(what: string): never {
  throw new Error(`Invalid SSE payload for ${what}`);
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string") fail(field);
  return value;
}

function decodeExecutionPhase(value: unknown): DossierExecutionPhase {
  if (
    value === "Queued" ||
    value === "Running" ||
    value === "Recovering" ||
    value === "Suspended"
  ) {
    return value;
  }
  return fail("advisory phase");
}

function decodeSubjectLocator(value: unknown): DossierSubjectLocatorWire {
  if (!isRecord(value)) fail("Started.subject_locator");
  if (value.kind === "Resource") {
    return { kind: "Resource", ref: str(value.ref, "Started.subject_locator.ref") };
  }
  if (value.kind === "Contributor") {
    return {
      kind: "Contributor",
      handle: str(value.handle, "Started.subject_locator.handle"),
    };
  }
  return fail("Started.subject_locator.kind");
}

/**
 * Decode one SSE frame (`type` = event name, `data` = payload) into a typed
 * `DossierStreamEvent`. Throws on any unknown type or malformed payload.
 */
export function decodeDossierStreamEvent(
  type: string,
  data: unknown,
): DossierStreamEvent {
  if (!isRecord(data)) fail(type || "message");
  switch (type) {
    case "Started":
      return {
        kind: "Started",
        buildHandle: str(data.build_handle, "Started.build_handle"),
        artifactRef: str(data.artifact_ref, "Started.artifact_ref"),
        subjectLocator: decodeSubjectLocator(data.subject_locator),
      };
    case "Progress":
      return {
        kind: "Progress",
        phase: str(data.phase, "Progress.phase"),
        message: str(data.message, "Progress.message"),
      };
    case "Delta":
      return {
        kind: "Delta",
        appendedText: str(data.appended_text, "Delta.appended_text"),
      };
    case "Succeeded":
      return {
        kind: "Succeeded",
        artifactRevisionRef: str(
          data.artifact_revision_ref,
          "Succeeded.artifact_revision_ref",
        ),
      };
    case "Failed":
      return {
        kind: "Failed",
        facts: {
          failureCode: decodeFailureCode(data.failure_code),
          detail: decodePresence(data.detail, (v) => str(v, "Failed.detail")),
          support: decodePresence(data.support, (v) => {
            if (!isRecord(v)) fail("Failed.support");
            return v;
          }),
        },
      };
    case "Cancelled":
      return {
        kind: "Cancelled",
        facts: {
          actor: decodePresence(data.actor, (v) => str(v, "Cancelled.actor")),
          at: str(data.at, "Cancelled.at"),
        },
      };
    case DOSSIER_ADVISORY_EVENT_TYPE:
      return { kind: "Advisory", phase: decodeExecutionPhase(data.phase) };
    default:
      throw new Error(`Unknown SSE event type: ${type || "message"}`);
  }
}

/** A persisted terminal build event (advisories never terminalize the stream). */
export function isTerminalDossierStreamEvent(
  event: DossierStreamEvent,
): boolean {
  return (
    event.kind === "Succeeded" ||
    event.kind === "Failed" ||
    event.kind === "Cancelled"
  );
}
