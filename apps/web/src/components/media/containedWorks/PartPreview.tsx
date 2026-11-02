"use client";

// Exact-selector query and bounded rendering shared by manual and proposal review.
import HtmlRenderer from "@/components/HtmlRenderer";
import { Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import type { Schema } from "@/lib/api/wire";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { previewPart } from "@/lib/media/parts";
import styles from "./parts.module.css";

export function usePartPreview(source: string, selection: Schema<"SectionSelection"> | null) {
  const key = selection === null ? null : JSON.stringify([source, selection]);
  return usePaneFreeServerValue({ key: key === null ? null : `part-preview:${key}`, stale: "",
    load: signal => previewPart(source, selection!, signal) });
}

export default function PartPreview({ preview }: { readonly preview: ReturnType<typeof usePartPreview> }) {
  if (preview.status === "failed") return <Failed error={preview.error} noun="included sections" retry={{ run: () => void preview.refetch(), busy: preview.retrying }} />;
  if (preview.status !== "ready") return <Ruling />;
  return <section aria-label="included text" className={styles.preview} onClickCapture={event => {
    if (event.target instanceof Element && event.target.closest("a")) event.preventDefault();
  }}>{preview.data.document.units.map(unit => <HtmlRenderer key={unit.id} htmlSanitized={unit.html_sanitized} headingLevelOffset={2} />)}</section>;
}
