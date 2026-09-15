import { describe, expect, it } from "vitest";
import corpus from "../../../../../testdata/contracts/chat-admission-receipts.json";
import {
  decodeChatAdmissionReceipt,
  decodeChatAdmissionResponse,
  decodeChatRunCreateRequest,
} from "./chatAdmission";
import { decodeChatDraftRecord } from "./chatDraftStore";

// Oracle: independently reviewed Python/TypeScript admission wire corpus.
describe("chat admission conformance", () => {
  it.each(corpus.valid)("accepts $name", ({ value }) => {
    expect(decodeChatAdmissionReceipt(value)).toEqual(value);
  });
  it.each(corpus.invalid)("rejects $name", ({ value }) => {
    expect(() => decodeChatAdmissionReceipt(value)).toThrow();
  });
  it("rejects a valid receipt for another command", () => {
    expect(() =>
      decodeChatAdmissionResponse(
        { data: corpus.valid[0].value },
        "different-command",
      ),
    ).toThrow("identity mismatch");
  });
  it.each([
    {
      selection: {
        route: "CodexPersonal",
        model: "gpt-5.6-terra",
        reasoning: "medium",
      },
      tool_authority: "ReadOnly",
    },
    {
      selection: {
        route: "ProviderApi",
        model_ref: "anthropic:claude-sonnet-4-5",
        reasoning: "high",
      },
      tool_authority: "AdditiveWrites",
    },
  ])(
    "preserves the exact generation choice and authority: $selection.route",
    (generation) => {
      const request = {
        destination: { kind: "New" },
        content: "question",
        catalog_definition_revision: "a".repeat(64),
        ...generation,
        reader_selection: { kind: "Absent" },
      };
      expect(decodeChatRunCreateRequest(request)).toEqual(request);
    },
  );
  it.each([
    { catalog_definition_revision: "not-a-revision" },
    {
      selection: {
        route: "ProviderApi",
        model_ref: "anthropic:claude-sonnet-4-5",
        reasoning: "turbo",
      },
    },
    {
      selection: {
        route: "CodexPersonal",
        model: "gpt-5.6-terra",
        reasoning: "medium",
        profile_id: "balanced",
      },
    },
    { tool_authority: "WriteEverything" },
    { profile_id: "balanced" },
  ])("rejects malformed or retired generation input: %j", (invalid) => {
    expect(() =>
      decodeChatRunCreateRequest({
        destination: { kind: "New" },
        content: "question",
        catalog_definition_revision: "a".repeat(64),
        selection: {
          route: "CodexPersonal",
          model: "gpt-5.6-terra",
          reasoning: "medium",
        },
        tool_authority: "ReadOnly",
        reader_selection: { kind: "Absent" },
        ...invalid,
      }),
    ).toThrow();
  });
  it("preserves a current submitting command and rejects malformed or ownerless stored request material", () => {

    const command = {
      idempotencyKey: "retained-command",
      origin: { identity: "origin-visit", accountId: "account-a" },
      request: {
        destination: { kind: "New" },
        content: "question",
        catalog_definition_revision: "a".repeat(64),
        selection: {
          route: "CodexPersonal",
          model: "gpt-5.6-terra",
          reasoning: "medium",
        },
        tool_authority: "ReadOnly",
        reader_selection: { kind: "Absent" },
      },
    };
    expect(
      decodeChatDraftRecord(
        JSON.stringify({
          text: "question",
          selection: null,
          toolAuthority: "ReadOnly",
          operation: { kind: "Submitting", command },
        }),
      ).operation,
    ).toEqual({ kind: "ReconcileRequired", command });
    expect(() =>
      decodeChatDraftRecord(
        JSON.stringify({
          text: "question",
          selection: null,
          toolAuthority: "ReadOnly",
          operation: {
            kind: "Submitting",
            command: { ...command, origin: undefined },
          },
        }),
      ),
    ).toThrow("origin");
    expect(() => decodeChatRunCreateRequest({ garbage: true })).toThrow();
    expect(() =>
      decodeChatDraftRecord(
        JSON.stringify({
          text: "question",
          selection: null,
          toolAuthority: "ReadOnly",
          operation: {
            kind: "Submitting",
            command: { idempotencyKey: "", request: {} },
          },
        }),
      ),
    ).toThrow();
  });
  it.each(["command", "conversation"])(
    "rejects stored acknowledgment belonging to another %s",
    (mismatch) => {
      const receipt = corpus.valid[0].value;
      const command = {
        idempotencyKey:
          mismatch === "command" ? "retained-command" : receipt.idempotency_key,
        origin: { identity: "origin-visit", accountId: "account-a" },
        request: {
          destination: {
            kind: "Existing",
            conversation_id: "99999999-9999-4999-8999-999999999999",
            insertion: {
              kind: "Reply",
              parent_message_id: "88888888-8888-4888-8888-888888888888",
              branch_anchor: { kind: "none" },
            },
          },
          content: "question",
          catalog_definition_revision: "a".repeat(64),
          selection: {
            route: "CodexPersonal",
            model: "gpt-5.6-terra",
            reasoning: "medium",
          },
          tool_authority: "ReadOnly",
          reader_selection: { kind: "Absent" },
        },
      };
      expect(() =>
        decodeChatDraftRecord(
          JSON.stringify({
            text: "question",
            selection: null,
            toolAuthority: "ReadOnly",
            operation: {
              kind: "Acknowledged",
              command,
              receipt,
            },
          }),
        ),
      ).toThrow("identity");
    },
  );
});
