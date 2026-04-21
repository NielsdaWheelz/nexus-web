"use client";

import { useEffect, useRef } from "react";
import styles from "./DocumentViewport.module.css";

export default function DocumentViewport({
  children,
  onScroll,
}: {
  children: React.ReactNode;
  onScroll?: (scrollTop: number) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || !onScroll) {
      return;
    }

    const handleScroll = () => {
      onScroll(node.scrollTop);
    };

    node.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", handleScroll);
    };
  }, [onScroll]);

  return (
    <div
      ref={viewportRef}
      className={styles.viewport}
      data-testid="document-viewport"
      data-pane-content="true"
      style={{ overflow: "auto" }}
    >
      {children}
    </div>
  );
}
