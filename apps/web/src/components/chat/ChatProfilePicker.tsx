"use client";

/**
 * ChatProfilePicker — the composer's product-facing LLM selector.
 *
 * Renders the GET /llm-profiles catalog (via useChatProfiles): a profile
 * chooser, that profile's reasoning options, and its privacy notice. It owns NO
 * provider/model/reasoning policy — it renders exactly what the endpoint returns
 * and reports a `{ profileId, reasoningOptionId }` selection up to the composer
 * (controlled). It replaces the old model + reasoning + key-mode controls.
 *
 * Defaulting: once the catalog loads, if the controlled value is empty or no
 * longer valid, it emits the server default profile + that profile's default
 * reasoning option.
 */

import { useEffect } from "react";
import Select from "@/components/ui/Select";
import { useChatProfiles } from "@/components/chat/useChatProfiles";
import type { LlmProfile } from "@/lib/conversations/types";
import styles from "./ChatProfilePicker.module.css";

export interface ProfileSelection {
  profileId: string;
  reasoningOptionId: string;
}

interface ChatProfilePickerProps {
  value: ProfileSelection | null;
  onChange: (value: ProfileSelection) => void;
  disabled?: boolean;
}

function isValidSelection(
  value: ProfileSelection | null,
  profiles: LlmProfile[],
): boolean {
  if (!value) return false;
  const profile = profiles.find((item) => item.id === value.profileId);
  if (!profile) return false;
  return profile.reasoning_options.some(
    (option) => option.id === value.reasoningOptionId,
  );
}

function defaultSelection(
  profiles: LlmProfile[],
  defaultProfileId: string | null,
): ProfileSelection | null {
  const profile =
    profiles.find((item) => item.id === defaultProfileId) ?? profiles[0];
  if (!profile) return null;
  return {
    profileId: profile.id,
    reasoningOptionId: profile.default_reasoning_option_id,
  };
}

export default function ChatProfilePicker({
  value,
  onChange,
  disabled = false,
}: ChatProfilePickerProps) {
  const { profiles, defaultProfileId, isLoading, error } = useChatProfiles();

  // Emit the server default (or repair an invalid selection) once the catalog
  // is known. The composer owns the state; this only seeds it.
  useEffect(() => {
    if (profiles.length === 0) return;
    if (isValidSelection(value, profiles)) return;
    const next = defaultSelection(profiles, defaultProfileId);
    if (next) onChange(next);
  }, [profiles, defaultProfileId, value, onChange]);

  if (error) {
    return (
      <span className={styles.status} role="status">
        AI profiles unavailable
      </span>
    );
  }

  if (isLoading || profiles.length === 0) {
    return (
      <span className={styles.status} role="status">
        Loading profiles…
      </span>
    );
  }

  const selectedProfile =
    profiles.find((item) => item.id === value?.profileId) ?? null;
  const reasoningOptions = selectedProfile?.reasoning_options ?? [];

  return (
    <div className={styles.picker}>
      <label className={styles.field}>
        <span className={styles.srOnly}>AI profile</span>
        <Select
          size="sm"
          aria-label="AI profile"
          value={value?.profileId ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const profile = profiles.find(
              (item) => item.id === event.target.value,
            );
            if (!profile) return;
            onChange({
              profileId: profile.id,
              reasoningOptionId: profile.default_reasoning_option_id,
            });
          }}
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label}
            </option>
          ))}
        </Select>
      </label>

      {reasoningOptions.length > 1 ? (
        <label className={styles.field}>
          <span className={styles.srOnly}>Reasoning</span>
          <Select
            size="sm"
            aria-label="Reasoning"
            value={value?.reasoningOptionId ?? ""}
            disabled={disabled}
            onChange={(event) => {
              if (!value) return;
              onChange({
                profileId: value.profileId,
                reasoningOptionId: event.target.value,
              });
            }}
          >
            {reasoningOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
      ) : null}

      {selectedProfile?.privacy_notice ? (
        <span className={styles.privacyNotice}>
          {selectedProfile.privacy_notice}
        </span>
      ) : null}
    </div>
  );
}
