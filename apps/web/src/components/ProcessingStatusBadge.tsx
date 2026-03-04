"use client";

import type { ReactNode } from "react";
import { CircleCheck, CircleX, Clock3, Cog, Search, BookOpen } from "lucide-react";
import styles from "./ProcessingStatusBadge.module.css";

export type ProcessingStatus =
  | "pending"
  | "extracting"
  | "ready_for_reading"
  | "embedding"
  | "ready"
  | "failed";

interface ProcessingStatusBadgeProps {
  status: ProcessingStatus;
  failureStage?: string | null;
  errorCode?: string | null;
  className?: string;
}

const STATUS_CONFIG: Record<
  ProcessingStatus,
  { label: string; variant: string; icon: ReactNode }
> = {
  pending: {
    label: "Queued",
    variant: "pending",
    icon: <Clock3 size={12} aria-hidden="true" />,
  },
  extracting: {
    label: "Processing",
    variant: "processing",
    icon: <Cog size={12} aria-hidden="true" />,
  },
  ready_for_reading: {
    label: "Readable",
    variant: "readable",
    icon: <BookOpen size={12} aria-hidden="true" />,
  },
  embedding: {
    label: "Indexing",
    variant: "processing",
    icon: <Search size={12} aria-hidden="true" />,
  },
  ready: {
    label: "Ready",
    variant: "ready",
    icon: <CircleCheck size={12} aria-hidden="true" />,
  },
  failed: {
    label: "Failed",
    variant: "failed",
    icon: <CircleX size={12} aria-hidden="true" />,
  },
};

export default function ProcessingStatusBadge({
  status,
  failureStage,
  errorCode,
  className = "",
}: ProcessingStatusBadgeProps) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.pending;

  // Build tooltip for failed status
  let tooltip: string | undefined;
  if (status === "failed") {
    const parts: string[] = [];
    if (failureStage) {
      parts.push(`Stage: ${failureStage}`);
    }
    if (errorCode) {
      parts.push(`Error: ${errorCode}`);
    }
    if (parts.length > 0) {
      tooltip = parts.join("\n");
    }
  }

  return (
    <span
      className={`${styles.badge} ${styles[config.variant]} ${className}`}
      title={tooltip}
    >
      <span className={styles.icon}>{config.icon}</span>
      <span className={styles.label}>{config.label}</span>
    </span>
  );
}
