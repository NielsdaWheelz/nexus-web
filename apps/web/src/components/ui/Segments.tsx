"use client";

import { useRef, type ReactNode } from "react";
import { cx } from "@/lib/ui/cx";
import { useIndicator } from "@/lib/ui/useIndicator";
import styles from "./Segments.module.css";

/** One native or menu radio group; its children retain input and key ownership. */
export default function Segments({ value, children, className }: {
  readonly value: string | null;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  useIndicator(host, value);
  return <div ref={host} className={cx(styles.track, className)}>
    {children}
    <span aria-hidden="true" data-indicator className={styles.thumb} />
  </div>;
}
