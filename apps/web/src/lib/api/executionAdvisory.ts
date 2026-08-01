import { isRecord } from "@/lib/validation";

/** Queue/coordination liveness. It is advisory-only and never a run status. */
export type DurableExecutionPhase =
  | "Queued"
  | "Running"
  | "Recovering"
  | "Suspended";

export interface DurableExecution {
  phase: DurableExecutionPhase;
}

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
