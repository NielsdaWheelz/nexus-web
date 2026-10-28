import { resourceIconForScheme, type ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import styles from "./ResourceType.module.css";

/** Passive type presentation; each surface owns identity, naming and activation. */
export function ResourceTypeIcon({ scheme }: { scheme: ResourceScheme }) {
  const Icon = resourceIconForScheme(scheme);
  return <Icon className={styles.icon} strokeWidth={2} aria-hidden="true" focusable="false" />;
}
