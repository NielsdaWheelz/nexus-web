"use client";

import { X } from "lucide-react";
import type { ConversationReference } from "@/lib/conversations/types";
import styles from "./ConversationReferencesRail.module.css";

export default function ConversationReferencesRail({
  references,
  removeReference,
  onOpenResource,
}: {
  references: ConversationReference[];
  removeReference: (referenceId: string) => Promise<void>;
  onOpenResource?: (uri: string) => void;
}) {
  if (references.length === 0) {
    return <p className={styles.empty}>No references yet.</p>;
  }
  return (
    <div className={styles.rail}>
      {references.map((reference) => (
        <div
          key={reference.id}
          className={`${styles.row} ${reference.missing ? styles.missing : ""}`.trim()}
        >
          <button
            type="button"
            className={styles.body}
            disabled={!onOpenResource || reference.missing}
            onClick={() => onOpenResource?.(reference.resource_uri)}
          >
            <span className={styles.label}>
              {reference.label}
              {reference.missing ? " (unavailable)" : null}
            </span>
            {reference.summary ? (
              <span className={styles.summary}>{reference.summary}</span>
            ) : null}
          </button>
          <button
            type="button"
            className={styles.remove}
            aria-label="Remove reference"
            onClick={() => {
              void removeReference(reference.id);
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
