"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cx } from "@/lib/ui/cx";
import styles from "./Disclosure.module.css";

interface DisclosureProps {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  summaryClassName?: string;
  regionClassName?: string;
}

export default function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className,
  summaryClassName,
  regionClassName,
}: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const buttonId = useId();
  const regionId = useId();

  return (
    <div className={cx(styles.root, className)} data-open={open ? "true" : "false"}>
      <button
        type="button"
        id={buttonId}
        className={cx(styles.summary, summaryClassName)}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={styles.chevron}
          data-open={open ? "true" : "false"}
        />
        <span>{summary}</span>
      </button>
      <div
        id={regionId}
        role="region"
        aria-labelledby={buttonId}
        className={cx(styles.region, regionClassName)}
        hidden={!open}
      >
        {children}
      </div>
    </div>
  );
}
