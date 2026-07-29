"use client";

/**
 * ChatProfilePicker — the composer's product-facing LLM selector.
 *
 * Renders the ready catalog and resolved selection that ChatComposer owns. It
 * reports only explicit user changes back to the draft.
 */

import Select from "@/components/ui/Select";
import type { ChatProfileSelection } from "@/lib/conversations/chatProfileSelection";
import type { LlmProfile } from "@/lib/conversations/types";
import styles from "./ChatProfilePicker.module.css";

interface ChatProfilePickerProps {
  profiles: readonly LlmProfile[];
  value: ChatProfileSelection;
  onChange: (value: ChatProfileSelection) => void;
  disabled?: boolean;
}

export default function ChatProfilePicker({
  profiles,
  value,
  onChange,
  disabled = false,
}: ChatProfilePickerProps) {
  const selectedProfile = profiles.find((item) => item.id === value.profileId);
  if (selectedProfile === undefined) {
    // justify-defect: the composer passes a resolver-validated ready selection.
    throw new Error("Resolved chat profile is absent from the ready catalog");
  }
  const reasoningOptions = selectedProfile.reasoning_options;

  return (
    <div className={styles.picker}>
      <label className={styles.field}>
        <span className={styles.srOnly}>AI profile</span>
        <Select
          size="sm"
          aria-label="AI profile"
          value={value.profileId}
          disabled={disabled}
          onChange={(event) => {
            const profile = profiles.find(
              (item) => item.id === event.target.value,
            );
            if (profile === undefined) {
              // justify-defect: a native select only emits one of its rendered options.
              throw new Error(
                "Selected chat profile is absent from the ready catalog",
              );
            }
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
            value={value.reasoningOptionId}
            disabled={disabled}
            onChange={(event) => {
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
    </div>
  );
}
