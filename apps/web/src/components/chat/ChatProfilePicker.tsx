"use client";

/**
 * ChatProfilePicker — the composer's product-facing LLM selector.
 *
 * Renders the ready catalog and resolved selection that ChatComposer owns. It
 * reports only explicit user changes back to the draft.
 */

import { useId } from "react";
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
  const groupName = useId();
  if (!profiles.some((item) => item.id === value.profileId)) {
    // justify-defect: the composer passes a resolver-validated ready selection.
    throw new Error("Resolved chat profile is absent from the ready catalog");
  }
  return (
    <div className={styles.picker} role="radiogroup" aria-label="Response profile">
      {profiles.map((profile) => {
        const selected = profile.id === value.profileId;
        return (
          <label
            key={profile.id}
            className={styles.option}
            data-selected={selected ? "true" : undefined}
            data-disabled={disabled ? "true" : undefined}
          >
            <input
              className={styles.radio}
              type="radio"
              name={groupName}
              value={profile.id}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange({ profileId: profile.id })}
            />
            <span className={styles.optionCopy}>
              <strong>{profile.label}</strong>
              <span>{profile.description}</span>
              <small>
                {profile.model_label} · {profile.effort_label}
              </small>
            </span>
          </label>
        );
      })}
    </div>
  );
}
