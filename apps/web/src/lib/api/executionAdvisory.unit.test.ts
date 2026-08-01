import { describe, expect, it } from "vitest";
import {
  decodeDurableExecution,
  decodeExecutionAdvisory,
} from "./executionAdvisory";

describe("strict execution advisory wire shape", () => {
  it.each(["Queued", "Running", "Recovering", "Suspended"] as const)(
    "accepts the exact %s phase without an SSE cursor",
    (phase) => {
      expect(decodeExecutionAdvisory({ phase })).toEqual({ phase });
    },
  );

  it("rejects widened, unknown, and cursor-bearing advisories", () => {
    for (const value of (
      [
        {},
        { phase: "running" },
        { phase: "Paused" },
        { phase: "Running", retry: true },
      ] as const
    )) {
      expect(() => decodeDurableExecution(value)).toThrow();
    }
    expect(() => decodeExecutionAdvisory({ phase: "Running" }, "1")).toThrow(
      "Invalid SSE payload for ExecutionAdvisory id",
    );
  });
});
