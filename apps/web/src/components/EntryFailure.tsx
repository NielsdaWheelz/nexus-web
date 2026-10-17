import type { ReactNode } from "react";
import AsterismMark from "@/components/AsterismMark";
import EntryCanvas from "@/components/EntryCanvas";
import { FeedbackState } from "@/components/feedback/Feedback";
import styles from "./EntryFailure.module.css";

export default function EntryFailure({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <EntryCanvas>
      <main className={styles.surface}>
        <AsterismMark size={32} className={styles.mark} />
        <FeedbackState
          content={{ tone: "Danger", title, message: description }}
          announcement="None"
        />
        {children}
      </main>
    </EntryCanvas>
  );
}
