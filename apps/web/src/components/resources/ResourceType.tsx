import type { ReactNode } from "react";
import { resourceIconForScheme, type ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import styles from "./ResourceType.module.css";

/** Passive type presentation; each surface owns identity, naming and activation. */
export function ResourceTypeIcon({ scheme }: { scheme: ResourceScheme }) {
  const Icon = resourceIconForScheme(scheme);
  return <Icon className={styles.icon} strokeWidth={2} aria-hidden="true" focusable="false" />;
}

export function ResourceIndexTitle({ scheme, hasArtwork, children }: {
  scheme: ResourceScheme; hasArtwork: boolean; children: ReactNode;
}) {
  if (scheme === "note_block" || (scheme === "podcast" && hasArtwork)) return <>{children}</>;
  return <span className={styles.title}>
    <ResourceTypeIcon scheme={scheme} />
    <span className={styles.text} dir="auto">{children}</span>
  </span>;
}
