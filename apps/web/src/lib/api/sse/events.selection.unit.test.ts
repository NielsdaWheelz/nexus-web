import { describe, expect, it } from "vitest";
import { RUN_SELECTION } from "@/lib/conversations/runSelection.test-support";
import {
  selectionStateExplanation,
  type RunSelectionOut,
} from "@/lib/conversations/generationCatalog";
import { toChatSSEEvent } from "./events";

// Reviewed with python/tests/kernel/test_generation_selection_wire_contract.py:
// both proofs pin the same lists, so a code added or removed on one side fails
// one of them instead of making a historical run undecodable here.
const INELIGIBLE_CODES = [
  "missing_target_qualification",
  "missing_reasoning_qualification",
  "missing_chat_tool_qualification",
  "unsupported_capability",
  "selection_not_configured",
] as const;
const READINESS_CODES = [
  "catalog_refresh_failed",
  "codex_host_unavailable",
  "credential_unavailable",
  "provider_unavailable",
  "quota_unavailable",
] as const;
const PROVIDER_REASONING_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const RETIRED_CODES = ["qualification_missing", "retired"] as const;
const OBSERVED_AT = "2026-08-31T20:00:00Z";

function meta(runSelection: unknown) {
  return {
    run_id: "run-1",
    conversation_id: "conversation-1",
    user_message_id: "user-1",
    assistant_message_id: "assistant-1",
    run_selection: runSelection,
    chat_subject: null,
  };
}

function decodeRunSelection(runSelection: unknown): RunSelectionOut {
  const event = toChatSSEEvent("meta", meta(runSelection), "1");
  if (event.type !== "meta") throw new Error(`meta decoded as ${event.type}`);
  return event.data.run_selection;
}

function readiness(
  kind: "OperatorActionRequired" | "TemporarilyUnavailable",
  code: string,
) {
  return {
    kind,
    code,
    explanation: `${code} explanation`,
    action: `${code} action`,
    last_checked: OBSERVED_AT,
  };
}

describe("chat SSE immutable run-selection contract", () => {
  it("decodes the complete immutable dispatch and current-state projection", () => {
    expect(toChatSSEEvent("meta", meta(RUN_SELECTION), "1")).toMatchObject({
      seq: 1,
      data: { run_selection: RUN_SELECTION },
    });
  });

  it("rejects an incomplete or widened projection", () => {
    expect(() =>
      toChatSSEEvent(
        "meta",
        meta({ ...RUN_SELECTION, compatibility_id: "retired" }),
        "1",
      ),
    ).toThrow("Invalid SSE payload for meta.run_selection");
    expect(() => toChatSSEEvent("meta", meta(null), "1")).toThrow(
      "Invalid SSE payload for meta.run_selection",
    );
  });

  it("decodes every reviewed selection-state code and refuses retired or unknown ones", () => {
    for (const code of INELIGIBLE_CODES) {
      const state = { kind: "Ineligible", code, explanation: `${code} explanation` };
      expect(
        decodeRunSelection({ ...RUN_SELECTION, current_state: state }).current_state,
        `Ineligible ${code} refused`,
      ).toEqual(state);
    }
    for (const code of READINESS_CODES) {
      for (const kind of ["OperatorActionRequired", "TemporarilyUnavailable"] as const) {
        const state = readiness(kind, code);
        expect(
          decodeRunSelection({ ...RUN_SELECTION, current_state: state }).current_state,
          `${kind} ${code} refused`,
        ).toEqual(state);
      }
    }
    for (const code of RETIRED_CODES) {
      expect(
        () =>
          decodeRunSelection({
            ...RUN_SELECTION,
            current_state: { kind: "Ineligible", code, explanation: "retired" },
          }),
        `Ineligible ${code} admitted`,
      ).toThrow("Invalid SSE payload for meta.run_selection");
      expect(
        () =>
          decodeRunSelection({
            ...RUN_SELECTION,
            current_state: readiness("OperatorActionRequired", code),
          }),
        `OperatorActionRequired ${code} admitted`,
      ).toThrow("Invalid SSE payload for meta.run_selection");
    }
  });

  it("keeps a run whose frozen selection left the catalog visible, explained, and not rerun-eligible", () => {
    const decoded = decodeRunSelection({
      ...RUN_SELECTION,
      current_state: {
        kind: "Ineligible",
        code: "selection_not_configured",
        explanation:
          "This run's exact selection is no longer in the configured catalog.",
      },
      rerun_eligibility: false,
    });
    expect(decoded.selection).toEqual(RUN_SELECTION.selection);
    expect(decoded.current_state.kind).toBe("Ineligible");
    expect(selectionStateExplanation(decoded.current_state)).toBe(
      "This run's exact selection is no longer in the configured catalog.",
    );
    expect(decoded.rerun_eligibility).toBe(false);
  });

  it("decodes every reviewed tool authority and provider reasoning level and refuses the rest", () => {
    for (const toolAuthority of ["ReadOnly", "AdditiveWrites"] as const) {
      expect(
        decodeRunSelection({ ...RUN_SELECTION, tool_authority: toolAuthority })
          .tool_authority,
      ).toBe(toolAuthority);
    }
    expect(() =>
      decodeRunSelection({ ...RUN_SELECTION, tool_authority: "None" }),
    ).toThrow("Invalid SSE payload for meta.run_selection");
    for (const reasoning of PROVIDER_REASONING_LEVELS) {
      const selection = {
        route: "ProviderApi",
        model_ref: "anthropic:claude-sonnet-4-5",
        reasoning,
      };
      expect(
        decodeRunSelection({ ...RUN_SELECTION, selection }).selection,
        `ProviderApi reasoning ${reasoning} refused`,
      ).toEqual(selection);
    }
    expect(() =>
      decodeRunSelection({
        ...RUN_SELECTION,
        selection: {
          route: "ProviderApi",
          model_ref: "anthropic:claude-sonnet-4-5",
          reasoning: "ultra",
        },
      }),
    ).toThrow("Invalid SSE payload for meta.run_selection");
  });
});
