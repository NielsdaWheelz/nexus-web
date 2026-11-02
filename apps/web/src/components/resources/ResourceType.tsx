import type { ReactNode } from "react";
import { resourceTypeGlyph, type ResourceType } from "@/lib/resources/type";
import styles from "./ResourceType.module.css";

/** Passive type presentation; each surface owns identity, naming and activation. */
export function ResourceTypeIcon({ type }: { type: ResourceType }) {
  const Icon = resourceTypeGlyph(type);
  return <Icon className={styles.icon} aria-hidden="true" focusable="false" />;
}

export function ResourceIndexTitle({ type, hasArtwork, children }: {
  type: ResourceType; hasArtwork: boolean; children: ReactNode;
}) {
  if (type.scheme === "note_block" || (type.scheme === "podcast" && hasArtwork)) return <>{children}</>;
  return <span className={styles.title} dir="auto">
    <ResourceTypeIcon type={type} />
    <span className={styles.text}>{children}</span>
  </span>;
}
