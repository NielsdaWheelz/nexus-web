import type { ReactNode } from "react";
import AsterismMark from "@/components/AsterismMark";
import styles from "./AuthSurface.module.css";

export default function AuthSurface({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.container}>
      <main className={styles.frame}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <AsterismMark
              size={40}
              className={styles.brandMark}
              aria-hidden="true"
            />
            <p className={styles.wordmark}>Nexus</p>
          </div>
          <div className={styles.introduction}>
            <h1 className={styles.title}>{title}</h1>
            {description ? (
              <p className={styles.description}>{description}</p>
            ) : null}
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}
