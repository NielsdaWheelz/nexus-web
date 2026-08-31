import {
  expectArray,
  expectExactRecord,
  expectNonemptyString,
  expectOneOf,
} from "@/lib/validation";

export const CHAT_PROFILE_IDS = ["fast", "balanced", "deep"] as const;
export type ChatProfileId = (typeof CHAT_PROFILE_IDS)[number];

export interface LlmProfile {
  id: ChatProfileId;
  label: string;
  description: string;
  model_label: string;
  effort_label: string;
}

export interface LlmProfilesOut {
  default_profile_id: "balanced";
  profiles: readonly [LlmProfile, LlmProfile, LlmProfile];
}

export function decodeChatProfileId(
  raw: unknown,
  name = "chat profile id",
): ChatProfileId {
  return expectOneOf(raw, CHAT_PROFILE_IDS, name);
}

function decodeLlmProfile(raw: unknown, index: number): LlmProfile {
  const name = `LLM profiles.profiles[${index}]`;
  const value = expectExactRecord(
    raw,
    ["id", "label", "description", "model_label", "effort_label"],
    name,
  );
  const id = decodeChatProfileId(value.id, `${name}.id`);
  if (id !== CHAT_PROFILE_IDS[index]) {
    throw new TypeError(
      `${name}.id must be ${JSON.stringify(CHAT_PROFILE_IDS[index])}`,
    );
  }
  return {
    id,
    label: expectNonemptyString(value.label, `${name}.label`),
    description: expectNonemptyString(
      value.description,
      `${name}.description`,
    ),
    model_label: expectNonemptyString(
      value.model_label,
      `${name}.model_label`,
    ),
    effort_label: expectNonemptyString(
      value.effort_label,
      `${name}.effort_label`,
    ),
  };
}

/** Strict decoder for the atomic three-preset product catalog. */
export function decodeLlmProfilesOut(raw: unknown): LlmProfilesOut {
  const value = expectExactRecord(
    raw,
    ["default_profile_id", "profiles"],
    "LLM profiles",
  );
  if (value.default_profile_id !== "balanced") {
    throw new TypeError('LLM profiles.default_profile_id must be "balanced"');
  }
  const rawProfiles = expectArray(
    value.profiles,
    (entry) => entry,
    "LLM profiles.profiles",
  );
  if (rawProfiles.length !== CHAT_PROFILE_IDS.length) {
    throw new TypeError("LLM profiles.profiles must contain exactly three rows");
  }
  const profiles = rawProfiles.map(decodeLlmProfile);
  return {
    default_profile_id: "balanced",
    profiles: [profiles[0]!, profiles[1]!, profiles[2]!],
  };
}

export function decodeLlmProfilesResponse(raw: unknown): LlmProfilesOut {
  const envelope = expectExactRecord(raw, ["data"], "LLM profiles response");
  return decodeLlmProfilesOut(envelope.data);
}
