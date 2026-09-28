import { isRecord } from "@/lib/validation";
import type { Schema } from "./wire";

/** Queue/coordination liveness. It is advisory-only and never a run status. */
export type DurableExecutionPhase = Schema<"DurableExecutionPhase">;
export type DurableExecution = Schema<"DurableExecutionOut">;
export type ChatRunExecution = Schema<"ChatRunExecutionOut">;

export const EXECUTION_ADVISORY_EVENT_TYPE = "ExecutionAdvisory";

function fail(what: string): never {
  throw new Error(`Invalid SSE payload for ${what}`);
}

export function decodeDurableExecutionPhase(
  value: unknown,
  what = "execution phase",
): DurableExecutionPhase {
  if (
    value === "Queued" ||
    value === "Running" ||
    value === "Recovering" ||
    value === "Suspended"
  ) {
    return value;
  }
  return fail(what);
}

/** Strictly decode the one shared `{ phase }` execution shape. */
export function decodeDurableExecution(
  value: unknown,
  what = "execution",
): DurableExecution {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !("phase" in value)
  ) {
    throw new Error(
      `Invalid SSE payload for ${what} fields; must contain exactly phase`,
    );
  }
  return {
    phase: decodeDurableExecutionPhase(value.phase, `${what}.phase`),
  };
}

/** Execution advisories must not carry an SSE id or advance the replay cursor. */
export function decodeExecutionAdvisory(
  value: unknown,
  id = "",
): DurableExecution {
  if (id !== "") {
    return fail("ExecutionAdvisory id");
  }
  return decodeDurableExecution(value, EXECUTION_ADVISORY_EVENT_TYPE);
}

export function decodeChatRunExecution(value: unknown): ChatRunExecution {
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
      !("phase" in value) || !("cancel_requested" in value) ||
      typeof value.cancel_requested !== "boolean") {
    return fail("chat execution fields");
  }
  return {
    phase: decodeDurableExecutionPhase(value.phase),
    cancel_requested: value.cancel_requested,
  };
}

export function decodeChatExecutionAdvisory(value: unknown, id = ""): ChatRunExecution {
  if (id !== "") return fail("ExecutionAdvisory id");
  return decodeChatRunExecution(value);
}
