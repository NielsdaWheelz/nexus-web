"use client";

import type { ComponentType } from "react";
import styles from "./SingletonChatRow.module.css";

interface SingletonChatRowProps {
  icon: ComponentType<{ size?: number }>;
  title: string;
  subtitle: string;
  onTap: () => void;
}

export default function SingletonChatRow({
  icon: Icon,
  title,
  subtitle,
  onTap,
}: SingletonChatRowProps) {
  return (
    <button type="button" className={styles.row} onClick={onTap}>
      <span className={styles.icon}>
        <Icon size={18} />
      </span>
      <span className={styles.content}>
        <span className={styles.title}>{title}</span>
        <span className={styles.subtitle}>{subtitle}</span>
      </span>
    </button>
  );
}
