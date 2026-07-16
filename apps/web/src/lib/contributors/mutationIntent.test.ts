import { describe, expect, it } from "vitest";
import { createMutationIntent } from "./mutationIntent";

function sequentialIds() {
  let n = 0;
  return () => `id-${++n}`;
}

describe("createMutationIntent", () => {
  it("reuses the same id across retries of an unchanged payload", () => {
    const intent = createMutationIntent(sequentialIds());
    const first = intent.clientMutationId("payload-a");
    const retry = intent.clientMutationId("payload-a");
    expect(first).toBe("id-1");
    expect(retry).toBe("id-1");
  });

  it("rotates to a fresh id when the payload key changes", () => {
    const intent = createMutationIntent(sequentialIds());
    expect(intent.clientMutationId("payload-a")).toBe("id-1");
    expect(intent.clientMutationId("payload-b")).toBe("id-2");
    // Returning to the original payload after a change still mints a fresh id.
    expect(intent.clientMutationId("payload-a")).toBe("id-3");
  });

  it("mints a fresh id for the same payload after a proven 409 mismatch", () => {
    const intent = createMutationIntent(sequentialIds());
    expect(intent.clientMutationId("payload-a")).toBe("id-1");
    intent.rotate();
    expect(intent.clientMutationId("payload-a")).toBe("id-2");
  });

  it("mints a fresh id for the same payload after discard on success", () => {
    const intent = createMutationIntent(sequentialIds());
    expect(intent.clientMutationId("payload-a")).toBe("id-1");
    intent.discard();
    expect(intent.clientMutationId("payload-a")).toBe("id-2");
  });
});
