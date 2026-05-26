"use client";

import { useEffect, useState } from "react";
import { Library } from "lucide-react";
import SingletonChatRow from "@/components/chat/SingletonChatRow";
import {
  fetchMediaLibraryMemberships,
  type LibraryTargetPickerItem,
} from "@/lib/media/mediaLibraries";
import { useLibraryChatSingleton } from "@/lib/conversations/useLibraryChatSingleton";
import styles from "./LibraryChatTab.module.css";

interface LibraryChatTabProps {
  mediaId: string;
  onOpenChat: (
    conversationId: string | null,
    libraryId: string,
    libraryName: string,
  ) => void;
}

export default function LibraryChatTab({
  mediaId,
  onOpenChat,
}: LibraryChatTabProps) {
  const [libraries, setLibraries] = useState<LibraryTargetPickerItem[]>([]);

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
      {libraries.length === 0 ? (
        <p className={styles.empty}>
          This document isn&apos;t in any additional libraries yet.
        </p>
      ) : (
        <ul className={styles.list}>
          {libraries.map((library) => (
            <li key={library.id}>
              <LibraryChatRow library={library} onOpenChat={onOpenChat} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LibraryChatRow({
  library,
  onOpenChat,
}: {
  library: LibraryTargetPickerItem;
  onOpenChat: (
    conversationId: string | null,
    libraryId: string,
    libraryName: string,
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
      onTap={() => onOpenChat(conversationId, library.id, library.name)}
    />
  );
}
