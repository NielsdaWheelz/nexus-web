import { describe, expect, it } from "vitest";
import { attemptForSend, type SendAttempt } from "./useChatDraft";

const REV_A = "a".repeat(64);
const REV_B = "b".repeat(64);

describe("attemptForSend", () => {
  it("mints a fresh in-flight attempt when there is none", () => {
    let n = 0;
    const attempt = attemptForSend(null, "identity-1", REV_A, () => `key-${++n}`);
    expect(attempt).toEqual({
      idempotencyKey: "key-1",
      payloadIdentity: "identity-1",
      revision: REV_A,
      status: "in_flight",
    });
  });

  it("replays the SAME key when the payload identity is unchanged (retry / reconcile)", () => {
    const current: SendAttempt = {
      idempotencyKey: "key-orig",
      payloadIdentity: "identity-1",
      revision: REV_A,
      status: "reconciling",
    };
    const attempt = attemptForSend(current, "identity-1", REV_A, () => "key-NEW");
    expect(attempt.idempotencyKey).toBe("key-orig");
    expect(attempt.status).toBe("in_flight");
  });

  it("reuses the key but refreshes the revision on a stale-revision reconfirmation", () => {
    const current: SendAttempt = {
      idempotencyKey: "key-orig",
      payloadIdentity: "identity-1",
      revision: REV_A,
      status: "retryable",
    };
    const attempt = attemptForSend(current, "identity-1", REV_B, () => "key-NEW");
    expect(attempt.idempotencyKey).toBe("key-orig");
    expect(attempt.revision).toBe(REV_B);
  });

  it("mints a NEW key when answer-determining input changed after a failure", () => {
    const current: SendAttempt = {
      idempotencyKey: "key-orig",
      payloadIdentity: "identity-1",
      revision: REV_A,
      status: "retryable",
    };
    const attempt = attemptForSend(current, "identity-2", REV_A, () => "key-NEW");
    expect(attempt.idempotencyKey).toBe("key-NEW");
    expect(attempt.payloadIdentity).toBe("identity-2");
  });
});
