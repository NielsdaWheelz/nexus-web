import { describe, expect, it } from "vitest";
import {
  attemptForSend,
  parseChatDraftRecord,
  type SendAttempt,
} from "./useChatDraft";

const REV_A = "a".repeat(64);
const REV_B = "b".repeat(64);
const PROFILE = { profileId: "balanced", reasoningOptionId: "deep" };

describe("attemptForSend", () => {
  it("mints a fresh in-flight attempt when there is none", () => {
    let n = 0;
    const attempt = attemptForSend(
      null,
      "identity-1",
      PROFILE,
      REV_A,
      () => `key-${++n}`,
    );
    expect(attempt).toEqual({
      idempotencyKey: "key-1",
      payloadIdentity: "identity-1",
      profileSelection: PROFILE,
      revision: REV_A,
      status: "in_flight",
    });
  });

  it("replays the SAME key when the payload identity is unchanged (retry / reconcile)", () => {
    const current: SendAttempt = {
      idempotencyKey: "key-orig",
      payloadIdentity: "identity-1",
      profileSelection: PROFILE,
      revision: REV_A,
      status: "reconciling",
    };
    const attempt = attemptForSend(
      current,
      "identity-1",
      PROFILE,
      REV_A,
      () => "key-NEW",
    );
    expect(attempt.idempotencyKey).toBe("key-orig");
    expect(attempt.status).toBe("in_flight");
  });

  it("reuses the key but refreshes the revision on a stale-revision reconfirmation", () => {
    const current: SendAttempt = {
      idempotencyKey: "key-orig",
      payloadIdentity: "identity-1",
      profileSelection: PROFILE,
      revision: REV_A,
      status: "retryable",
    };
    const attempt = attemptForSend(
      current,
      "identity-1",
      PROFILE,
      REV_B,
      () => "key-NEW",
    );
    expect(attempt.idempotencyKey).toBe("key-orig");
    expect(attempt.revision).toBe(REV_B);
  });

  it("mints a NEW key when answer-determining input changed after a failure", () => {
    const current: SendAttempt = {
      idempotencyKey: "key-orig",
      payloadIdentity: "identity-1",
      profileSelection: PROFILE,
      revision: REV_A,
      status: "retryable",
    };
    const attempt = attemptForSend(
      current,
      "identity-2",
      PROFILE,
      REV_A,
      () => "key-NEW",
    );
    expect(attempt.idempotencyKey).toBe("key-NEW");
    expect(attempt.payloadIdentity).toBe("identity-2");
  });

  it("replays the locked selection and key when the current catalog resolution changed", () => {
    const current: SendAttempt = {
      idempotencyKey: "key-orig",
      payloadIdentity: "identity-old-default",
      profileSelection: PROFILE,
      revision: REV_A,
      status: "reconciling",
    };
    const replacement = { profileId: "new-default", reasoningOptionId: "high" };

    const attempt = attemptForSend(
      current,
      "identity-new-default",
      replacement,
      REV_B,
      () => "key-NEW",
    );

    expect(attempt.idempotencyKey).toBe("key-orig");
    expect(attempt.payloadIdentity).toBe("identity-old-default");
    expect(attempt.profileSelection).toEqual(PROFILE);
    expect(attempt.revision).toBe(REV_A);
  });
});

describe("parseChatDraftRecord", () => {
  it("accepts an exact explicit selection or null", () => {
    expect(
      parseChatDraftRecord(
        JSON.stringify({
          text: "Continue this",
          profile: { profileId: "balanced", reasoningOptionId: "deep" },
          attempt: null,
        }),
      ),
    ).toEqual({
      text: "Continue this",
      profile: { profileId: "balanced", reasoningOptionId: "deep" },
      attempt: null,
    });

    expect(
      parseChatDraftRecord(
        JSON.stringify({ text: "", profile: null, attempt: null }),
      ),
    ).toEqual({ text: "", profile: null, attempt: null });
  });

  it("accepts the exact send snapshot and promotes interrupted in-flight work", () => {
    expect(
      parseChatDraftRecord(
        JSON.stringify({
          text: "Continue this",
          profile: null,
          attempt: {
            idempotencyKey: "key-1",
            payloadIdentity: "identity-1",
            profileSelection: PROFILE,
            revision: REV_A,
            status: "in_flight",
          },
        }),
      ),
    ).toEqual({
      text: "Continue this",
      profile: null,
      attempt: {
        idempotencyKey: "key-1",
        payloadIdentity: "identity-1",
        profileSelection: PROFILE,
        revision: REV_A,
        status: "reconciling",
      },
    });
  });

  it("rejects malformed, legacy, and expanded persisted profile selections", () => {
    for (const profile of [
      { profile_id: "balanced", reasoning_option_id: "deep" },
      { profileId: "balanced" },
      { profileId: "balanced", reasoningOptionId: "deep", version: 1 },
      "balanced",
    ]) {
      expect(
        parseChatDraftRecord(
          JSON.stringify({ text: "Continue this", profile, attempt: null }),
        ),
      ).toBeNull();
    }

    expect(
      parseChatDraftRecord(
        JSON.stringify({ text: "Continue this", attempt: null }),
      ),
    ).toBeNull();
  });

  it("rejects malformed attempts and expanded draft records", () => {
    const selection = { profileId: "balanced", reasoningOptionId: "deep" };
    expect(
      parseChatDraftRecord(
        JSON.stringify({
          text: "Continue this",
          profile: selection,
          attempt: {
            idempotencyKey: "key-1",
            payloadIdentity: "identity-1",
            profileSelection: selection,
            revision: null,
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseChatDraftRecord(
        JSON.stringify({
          text: "Continue this",
          profile: selection,
          attempt: {
            idempotencyKey: "key-1",
            payloadIdentity: "identity-1",
            revision: null,
            status: "retryable",
          },
        }),
      ),
    ).toBeNull();
    expect(
      parseChatDraftRecord(
        JSON.stringify({
          text: "Continue this",
          profile: selection,
          attempt: null,
          version: 1,
        }),
      ),
    ).toBeNull();
  });
});
