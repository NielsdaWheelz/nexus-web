import type { ReactNode } from "react";
import styles from "@/components/resources/ResourceContent.module.css";

/** Phrasing-only title and bibliography; row families place them independently. */
export default function MediaIdentity({ title }: { title: ReactNode }) { return <span data-resource-primary className={styles.named}>{title || "untitled"}</span>; }

