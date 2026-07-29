import { describe, expect, it } from "vitest";
import type { LlmProfile } from "@/lib/conversations/types";
import {
  resolveChatProfileSelection,
  type ChatProfileSelection,
  type InheritedChatProfileSelection,
} from "./chatProfileSelection";

const DEFAULT_SELECTION: ChatProfileSelection = {
  profileId: "balanced",
  reasoningOptionId: "default",
};

const DEEP_SELECTION: ChatProfileSelection = {
  profileId: "balanced",
  reasoningOptionId: "deep",
};

const PROFILES: LlmProfile[] = [
  {
    id: "balanced",
    label: "Balanced",
    description: "Everyday profile",
    provider_label: "Nexus AI",
    model_label: "Sonnet",
    reasoning_options: [
      { id: "default", label: "Default" },
      { id: "deep", label: "Deep" },
    ],
    default_reasoning_option_id: "default",
    privacy: { kind: "Standard", notice: "Processed by Nexus AI." },
  },
  {
    id: "fast",
    label: "Fast",
    description: "Low-latency profile",
    provider_label: "Nexus AI",
    model_label: "Haiku",
    reasoning_options: [{ id: "default", label: "Default" }],
    default_reasoning_option_id: "default",
    privacy: { kind: "Standard", notice: "Processed by Nexus AI." },
  },
];

const INHERITED: InheritedChatProfileSelection = {
  selection: DEEP_SELECTION,
  assistantMessageId: "assistant-1",
  runId: "run-1",
};

function resolve({
  draftSelection = null,
  inheritedSelection = INHERITED,
  profiles = PROFILES,
  defaultProfileId = "balanced",
}: Partial<Parameters<typeof resolveChatProfileSelection>[0]> = {}) {
  return resolveChatProfileSelection({
    draftSelection,
    inheritedSelection,
    profiles,
    defaultProfileId,
  });
}

describe("resolveChatProfileSelection", () => {
  it("uses an available explicit draft over causal inheritance", () => {
    expect(resolve({ draftSelection: { profileId: "fast", reasoningOptionId: "default" } })).toEqual({
      kind: "Draft",
      selection: { profileId: "fast", reasoningOptionId: "default" },
    });
  });

  it("uses the causal inherited selection when there is no explicit draft", () => {
    expect(resolve({ draftSelection: null })).toEqual({
      kind: "Inherited",
      selection: DEEP_SELECTION,
      assistantMessageId: "assistant-1",
      runId: "run-1",
    });
  });

  it("uses the exact product default when neither draft nor inheritance exists", () => {
    expect(resolve({ draftSelection: null, inheritedSelection: null })).toEqual({
      kind: "ProductDefault",
      selection: DEFAULT_SELECTION,
    });
  });

  it("replaces an unavailable draft with the exact product default", () => {
    const unavailableSelection = { profileId: "retired", reasoningOptionId: "high" };
    expect(resolve({ draftSelection: unavailableSelection })).toEqual({
      kind: "UnavailableReplacement",
      source: "Draft",
      unavailableSelection,
      selection: DEFAULT_SELECTION,
    });
  });

  it("replaces an inherited selection whose reasoning option was retired", () => {
    const unavailableSelection = { profileId: "balanced", reasoningOptionId: "retired" };
    expect(
      resolve({
        draftSelection: null,
        inheritedSelection: {
          selection: unavailableSelection,
          assistantMessageId: "assistant-1",
          runId: "run-1",
        },
      }),
    ).toEqual({
      kind: "UnavailableReplacement",
      source: "Inherited",
      unavailableSelection,
      selection: DEFAULT_SELECTION,
    });
  });

  it("defects when the ready catalog omits its configured default profile", () => {
    expect(() => resolve({ defaultProfileId: "missing" })).toThrow(
      'LLM profile catalog default profile "missing" is unavailable',
    );
  });

  it("defects when the ready catalog default profile omits its configured default reasoning option", () => {
    expect(() =>
      resolve({
        profiles: [
          {
            ...PROFILES[0],
            reasoning_options: [{ id: "deep", label: "Deep" }],
          },
        ],
      }),
    ).toThrow(
      'LLM profile catalog default reasoning option "default" is unavailable for profile "balanced"',
    );
  });
});
