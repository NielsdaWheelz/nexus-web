import type { LlmProfile } from "@/lib/conversations/types";

export interface ChatProfileSelection {
  readonly profileId: string;
  readonly reasoningOptionId: string;
}

export interface InheritedChatProfileSelection {
  readonly selection: ChatProfileSelection;
  readonly assistantMessageId: string;
  readonly runId: string;
}

export type ResolvedChatProfileSelection =
  | { readonly kind: "Draft"; readonly selection: ChatProfileSelection }
  | {
      readonly kind: "Inherited";
      readonly selection: ChatProfileSelection;
      readonly assistantMessageId: string;
      readonly runId: string;
    }
  | { readonly kind: "ProductDefault"; readonly selection: ChatProfileSelection }
  | {
      readonly kind: "UnavailableReplacement";
      readonly source: "Draft" | "Inherited";
      readonly unavailableSelection: ChatProfileSelection;
      readonly selection: ChatProfileSelection;
    };

interface ResolveChatProfileSelectionInput {
  readonly draftSelection: ChatProfileSelection | null;
  readonly inheritedSelection: InheritedChatProfileSelection | null;
  readonly profiles: readonly LlmProfile[];
  readonly defaultProfileId: string;
}

export function isChatProfileSelection(value: unknown): value is ChatProfileSelection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(value, "profileId") ||
    !Object.hasOwn(value, "reasoningOptionId")
  ) {
    return false;
  }
  const selection = value as Record<string, unknown>;
  return (
    typeof selection.profileId === "string" &&
    typeof selection.reasoningOptionId === "string"
  );
}

function isAvailable(
  selection: ChatProfileSelection,
  profiles: readonly LlmProfile[],
): boolean {
  const profile = profiles.find((item) => item.id === selection.profileId);
  return (
    profile !== undefined &&
    profile.reasoning_options.some((option) => option.id === selection.reasoningOptionId)
  );
}

function productDefaultSelection(
  profiles: readonly LlmProfile[],
  defaultProfileId: string,
): ChatProfileSelection {
  const profile = profiles.find((item) => item.id === defaultProfileId);
  if (profile === undefined) {
    // justify-defect: a ready same-system catalog must contain its configured default.
    throw new Error(
      `LLM profile catalog default profile "${defaultProfileId}" is unavailable`,
    );
  }
  if (
    !profile.reasoning_options.some(
      (option) => option.id === profile.default_reasoning_option_id,
    )
  ) {
    // justify-defect: a ready same-system default profile must expose its default option.
    throw new Error(
      `LLM profile catalog default reasoning option "${profile.default_reasoning_option_id}" is unavailable for profile "${profile.id}"`,
    );
  }
  return {
    profileId: profile.id,
    reasoningOptionId: profile.default_reasoning_option_id,
  };
}

export function resolveChatProfileSelection({
  draftSelection,
  inheritedSelection,
  profiles,
  defaultProfileId,
}: ResolveChatProfileSelectionInput): ResolvedChatProfileSelection {
  const productDefault = productDefaultSelection(profiles, defaultProfileId);

  if (draftSelection !== null) {
    if (isAvailable(draftSelection, profiles)) {
      return { kind: "Draft", selection: draftSelection };
    }
    return {
      kind: "UnavailableReplacement",
      source: "Draft",
      unavailableSelection: draftSelection,
      selection: productDefault,
    };
  }

  if (inheritedSelection !== null) {
    if (isAvailable(inheritedSelection.selection, profiles)) {
      return {
        kind: "Inherited",
        selection: inheritedSelection.selection,
        assistantMessageId: inheritedSelection.assistantMessageId,
        runId: inheritedSelection.runId,
      };
    }
    return {
      kind: "UnavailableReplacement",
      source: "Inherited",
      unavailableSelection: inheritedSelection.selection,
      selection: productDefault,
    };
  }

  return { kind: "ProductDefault", selection: productDefault };
}
