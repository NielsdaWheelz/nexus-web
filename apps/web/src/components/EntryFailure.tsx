import type { ReactNode } from "react";
import AsterismMark from "@/components/AsterismMark";
import EntryCanvas from "@/components/EntryCanvas";
import { Fact } from "@/components/feedback/Fact";
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
        <Fact line={{ fact: title, reason: description }} />
        {children}
      </main>
    </EntryCanvas>
  );
}
