import {
  decodeChatProfileId,
  type ChatProfileId,
  type LlmProfile,
} from "@/lib/conversations/chatProfileContract";

export interface ChatProfileSelection {
  readonly profileId: ChatProfileId;
}

export interface InheritedChatProfileSelection {
  readonly selection: { readonly profileId: string };
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
      readonly unavailableSelection: { readonly profileId: string };
      readonly selection: ChatProfileSelection;
    };

interface ResolveChatProfileSelectionInput {
  readonly draftSelection: ChatProfileSelection | null;
  readonly inheritedSelection: InheritedChatProfileSelection | null;
  readonly profiles: readonly LlmProfile[];
  readonly defaultProfileId: ChatProfileId;
}

export function isChatProfileSelection(
  value: unknown,
): value is ChatProfileSelection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || !Object.hasOwn(value, "profileId")) {
    return false;
  }
  const selection = value as Record<string, unknown>;
  try {
    decodeChatProfileId(
      selection.profileId,
      "chat profile selection.profileId",
    );
    return true;
  } catch {
    return false;
  }
}

function isAvailable(
  selection: { readonly profileId: string },
  profiles: readonly LlmProfile[],
): LlmProfile | undefined {
  return profiles.find((item) => item.id === selection.profileId);
}

function productDefaultSelection(
  profiles: readonly LlmProfile[],
  defaultProfileId: ChatProfileId,
): ChatProfileSelection {
  const profile = profiles.find((item) => item.id === defaultProfileId);
  if (profile === undefined) {
    // justify-defect: a ready same-system catalog must contain its configured default.
    throw new Error(
      `LLM profile catalog default profile "${defaultProfileId}" is unavailable`,
    );
  }
  return { profileId: profile.id };
}

export function resolveChatProfileSelection({
  draftSelection,
  inheritedSelection,
  profiles,
  defaultProfileId,
}: ResolveChatProfileSelectionInput): ResolvedChatProfileSelection {
  const productDefault = productDefaultSelection(profiles, defaultProfileId);

  if (draftSelection !== null) {
    const profile = isAvailable(draftSelection, profiles);
    if (profile) {
      return { kind: "Draft", selection: { profileId: profile.id } };
    }
    return {
      kind: "UnavailableReplacement",
      source: "Draft",
      unavailableSelection: draftSelection,
      selection: productDefault,
    };
  }

  if (inheritedSelection !== null) {
    const profile = isAvailable(inheritedSelection.selection, profiles);
    if (profile) {
      return {
        kind: "Inherited",
        selection: { profileId: profile.id },
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
