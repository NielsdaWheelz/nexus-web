"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import FeatureErrorBoundary from "@/components/feedback/FeatureErrorBoundary";
import styles from "./Nexus.module.css";

function NexusRecovery({ active, retry }: { active: boolean; retry(): void }) {
  const region = useRef<HTMLElement>(null);
  useEffect(() => { if (active) region.current?.focus(); }, [active]);
  return <section ref={region} role="alert" aria-labelledby="nexus-recovery-title" tabIndex={-1} className={styles.failure}>
    <h2 id="nexus-recovery-title">Nexus couldn’t load</h2>
    <p>Retry to reload Nexus. A selection it hadn’t saved to your history is sent again, and still counts once.</p>
    <Button onClick={retry}>Retry Nexus</Button>
  </section>;
}

export default function NexusErrorBoundary({ children, active, onRetry }: {
  children: ReactNode; active: boolean; onRetry(): void;
}) {
  return <FeatureErrorBoundary scope="Nexus" onRetry={onRetry}
    fallback={(retry) => <NexusRecovery active={active} retry={retry} />}>
    {children}
  </FeatureErrorBoundary>;
}
