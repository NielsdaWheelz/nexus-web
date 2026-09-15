import { absent, present, type Presence } from "@/lib/api/presence";
import { isApiError } from "@/lib/api/client";
import {
  expectExactRecord,
  expectOneOf,
  expectString,
  isCanonicalUuid,
} from "@/lib/validation";

export interface ClientDefectReport {
  pane_id: string;
  visit_id: string;
  phase: "Admission" | "Read" | "Render";
  command_id: Presence<string>;
  run_id: Presence<string>;
  error_code: string;
  request_id: Presence<string>;
  component_stack: string;
}
export interface ClientDefectContext {
  phase: ClientDefectReport["phase"];
  commandId?: string;
  runId?: string;
}
const contexts = new WeakMap<Error, ClientDefectContext>();
const reported = new WeakSet<object>();
let reports = 0;
const MAX_REPORTS = 32;
const CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

/** Attach structural context without exposing the source error's message. */
export function withClientDefectContext(
  error: unknown,
  context: ClientDefectContext,
): Error {
  const defect =
    error instanceof Error ? error : new Error("Client operation failed");
  contexts.set(defect, context);
  return defect;
}
function bounded(
  raw: unknown,
  name: string,
  max: number,
  empty = false,
): string {
  const value = expectString(raw, name);
  if ((!empty && !value) || value.length > max)
    throw new TypeError(`Invalid ${name}`);
  return value;
}
function decodeOptional(
  raw: unknown,
  name: string,
  max: number,
  requireUuid = false,
): Presence<string> {
  const value = expectExactRecord(
    raw,
    typeof raw === "object" &&
      raw !== null &&
      "kind" in raw &&
      raw.kind === "Absent"
      ? ["kind"]
      : ["kind", "value"],
    name,
  );
  if (value.kind === "Absent") return absent();
  if (value.kind !== "Present") throw new TypeError(`Invalid ${name}`);
  const text = bounded(value.value, name, max);
  if (requireUuid && !isCanonicalUuid(text))
    throw new TypeError(`Invalid ${name}`);
  return present(text);
}
/** BFF ingress accepts structure only; release identity is server-owned. */
export function decodeClientDefectReport(raw: unknown): ClientDefectReport {
  const value = expectExactRecord(
    raw,
    [
      "pane_id",
      "visit_id",
      "phase",
      "command_id",
      "run_id",
      "error_code",
      "request_id",
      "component_stack",
    ],
    "Client defect report",
  );
  const error_code = bounded(value.error_code, "error code", 128);
  if (!CODE.test(error_code))
    throw new TypeError("Invalid structural error code");
  return {
    pane_id: bounded(value.pane_id, "pane ID", 128),
    visit_id: bounded(value.visit_id, "visit ID", 128),
    phase: expectOneOf(
      value.phase,
      ["Admission", "Read", "Render"],
      "defect phase",
    ),
    command_id: decodeOptional(value.command_id, "command ID", 128),
    run_id: decodeOptional(value.run_id, "run ID", 36, true),
    error_code,
    request_id: decodeOptional(value.request_id, "request ID", 200),
    component_stack: bounded(
      value.component_stack,
      "component stack",
      8000,
      true,
    ),
  };
}
export function reportClientDefect(
  error: unknown,
  view: { paneId: string; visitId: string; componentStack: string },
): void {
  if (typeof window === "undefined" || reports >= MAX_REPORTS) return;
  if (error !== null && typeof error === "object") {
    if (reported.has(error)) return;
    reported.add(error);
  }
  reports += 1;
  const context = error instanceof Error ? contexts.get(error) : undefined;
  const code =
    isApiError(error) && CODE.test(error.code) ? error.code : "E_CLIENT_DEFECT";
  const report: ClientDefectReport = {
    pane_id: view.paneId.slice(0, 128),
    visit_id: view.visitId.slice(0, 128),
    phase: context?.phase ?? "Render",
    command_id: context?.commandId ? present(context.commandId) : absent(),
    run_id: context?.runId ? present(context.runId) : absent(),
    error_code: code,
    request_id:
      isApiError(error) && error.requestId
        ? present(error.requestId.slice(0, 200))
        : absent(),
    component_stack: view.componentStack.slice(0, 8000),
  };
  try {
    navigator.sendBeacon(
      "/api/telemetry/client-defects",
      new Blob([JSON.stringify(report)], { type: "application/json" }),
    );
  } catch {
    // justify-ignore-error: optional telemetry delivery has no application-state
    // authority; browser beacon rejection is terminal and never reported again.
  }
}
