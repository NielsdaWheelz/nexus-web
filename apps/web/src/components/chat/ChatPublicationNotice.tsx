"use client";

import { TriangleAlert } from "lucide-react";
import type { Presence } from "@/lib/api/presence";
import type { ChatPublicationWarning } from "@/lib/conversations/types";
import styles from "./ChatPublicationNotice.module.css";

const COPY: Record<
  ChatPublicationWarning["code"],
  { title: string; body: string }
> = {
  CitationsUnavailable: {
    title: "References unavailable",
    body: "the answer completed, but its references could not be attached reliably.",
  },
};

export default function ChatPublicationNotice({
  warning,
  supportId,
}: {
  warning: ChatPublicationWarning;
  supportId: Presence<string>;
}) {
  const copy = COPY[warning.code];
  return (
    <div className={styles.notice} role="status">
      <TriangleAlert className={styles.icon} size={15} aria-hidden="true" />
      <p className={styles.message}>
        <strong>{copy.title}</strong>
        {` — ${copy.body}`}
      </p>
      {supportId.kind === "Present" ? (
        <p className={styles.supportId}>Support ID: {supportId.value}</p>
      ) : null}
    </div>
  );
}
