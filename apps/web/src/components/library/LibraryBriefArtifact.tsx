"use client";

import { MessageSquare } from "lucide-react";
import Button from "@/components/ui/Button";
import MachineText from "@/components/ui/MachineText";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import type { ReaderCitationData } from "@/lib/conversations/readerCitation";
import type { ResourceActivation } from "@/lib/resources/activation";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import styles from "./LibraryBrief.module.css";

/**
 * The expanded dossier body: the full `content_md` rendered through
 * `MarkdownMessage` (with its citations) inside one `MachineText` block (signed
 * DOSSIER), plus the quiet "Chat about this dossier" opener (D-6).
 */
export default function LibraryBriefArtifact({
  content,
  citations,
  onCitationActivate,
  onChat,
  chatDisabled,
}: {
  content: string;
  citations: ReaderCitationData[];
  onCitationActivate: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
  onChat: () => void;
  chatDisabled: boolean;
}) {
  return (
    <div className={styles.artifact}>
      <MachineText origin={{ label: "Dossier" }} className={styles.artifactBody}>
        <MarkdownMessage
          content={content}
          citations={citations}
          onCitationActivate={onCitationActivate}
        />
      </MachineText>
      <Button
        variant="ghost"
        size="sm"
        onClick={onChat}
        disabled={chatDisabled}
        leadingIcon={<MessageSquare size={16} aria-hidden="true" />}
      >
        Chat about this dossier
      </Button>
    </div>
  );
}
