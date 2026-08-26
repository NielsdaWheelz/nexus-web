import type { ReactNode } from "react";
import AsterismMark from "@/components/AsterismMark";
import EntryCanvas from "@/components/EntryCanvas";
import { PRODUCT_DESCRIPTOR, PRODUCT_NAME } from "@/lib/productIdentity";
import styles from "./AuthSurface.module.css";

interface AuthSurfaceProps {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}

export default function AuthSurface({
  title,
  description,
  children,
}: AuthSurfaceProps) {
  return (
    <EntryCanvas>
      <main className={styles.surface}>
        <div className={styles.identity}>
          <AsterismMark
            size={64}
            className={styles.brandMark}
            aria-hidden="true"
          />
          <div className={styles.identityCopy}>
            <p className={styles.wordmark}>{PRODUCT_NAME}</p>
            <p className={styles.descriptor}>{PRODUCT_DESCRIPTOR}</p>
          </div>
        </div>
        <section className={styles.task}>
          <div className={styles.introduction}>
            <h1 className={styles.title}>{title}</h1>
            {description ? (
              <p className={styles.description}>{description}</p>
            ) : null}
          </div>
          {children}
        </section>
      </main>
    </EntryCanvas>
  );
}
