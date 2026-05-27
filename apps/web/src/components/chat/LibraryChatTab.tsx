"use client";

import { useEffect, useState } from "react";
import { Library } from "lucide-react";
import ComposerContextRail from "@/components/chat/ComposerContextRail";
import SingletonChatRow from "@/components/chat/SingletonChatRow";
import type { ContextItem } from "@/lib/api/sse/requests";
import {
  fetchMediaLibraryMemberships,
  type LibraryTargetPickerItem,
} from "@/lib/media/mediaLibraries";
import { useLibraryChatSingleton } from "@/lib/conversations/useLibraryChatSingleton";
import styles from "./LibraryChatTab.module.css";

interface LibraryChatTabProps {
  mediaId: string;
  pendingContexts?: ContextItem[];
  onRemovePendingContext?: (index: number) => void;
  onOpenChat: (
    conversationId: string | null,
    libraryId: string,
    libraryName: string,
    attachedContexts?: ContextItem[],
  ) => void;
}

export default function LibraryChatTab({
  mediaId,
  pendingContexts = [],
  onRemovePendingContext,
  onOpenChat,
}: LibraryChatTabProps) {
  const [libraries, setLibraries] = useState<LibraryTargetPickerItem[]>([]);
  const attachedContexts =
    pendingContexts.length > 0 ? pendingContexts : undefined;

  useEffect(() => {
    let cancelled = false;
    fetchMediaLibraryMemberships(mediaId, { excludeDefault: true })
      .then((result) => {
        if (cancelled) return;
        setLibraries(result.filter((library) => library.isInLibrary));
      })
      .catch(() => {
        if (cancelled) return;
        setLibraries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  return (
    <div className={styles.tab}>
      <h3 className={styles.sectionHeader}>Libraries containing this document</h3>
      {attachedContexts ? (
        <div className={styles.pendingContextStrip}>
          <span className={styles.pendingContextLabel}>Pending context</span>
          <ComposerContextRail
            attachedContexts={attachedContexts}
            onRemoveContext={(index) => onRemovePendingContext?.(index)}
          />
        </div>
      ) : null}
      {libraries.length === 0 ? (
        <p className={styles.empty}>
          This document isn&apos;t in any additional libraries yet.
        </p>
      ) : (
        <ul className={styles.list}>
          {libraries.map((library) => (
            <li key={library.id}>
              <LibraryChatRow
                library={library}
                attachedContexts={attachedContexts}
                onOpenChat={onOpenChat}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LibraryChatRow({
  library,
  attachedContexts,
  onOpenChat,
}: {
  library: LibraryTargetPickerItem;
  attachedContexts?: ContextItem[];
  onOpenChat: (
    conversationId: string | null,
    libraryId: string,
    libraryName: string,
    attachedContexts?: ContextItem[],
  ) => void;
}) {
  const { conversationId, messageCount } = useLibraryChatSingleton(library.id);
  return (
    <SingletonChatRow
      icon={Library}
      title={library.name}
      subtitle={
        messageCount > 0
          ? `${messageCount} ${messageCount === 1 ? "message" : "messages"}`
          : "No messages yet"
      }
      onTap={() =>
        attachedContexts
          ? onOpenChat(conversationId, library.id, library.name, attachedContexts)
          : onOpenChat(conversationId, library.id, library.name)
      }
    />
  );
}
