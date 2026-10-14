import type { ReactNode } from "react";
import AsterismMark from "@/components/AsterismMark";
import EntryCanvas from "@/components/EntryCanvas";
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
        <div className={styles.copy}>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.description}>{description}</p>
        </div>
        {children}
      </main>
    </EntryCanvas>
  );
}
