"use client";

import { useId, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { FieldFeedback } from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Select from "@/components/ui/Select";
import { useReaderState, type Reader } from "../DocumentReader";
import { PDF_ZOOM } from "../model";
import styles from "./ReaderNavigation.module.css";

/** The reader's canonical structure and position, presented in pane chrome. */
export default function ReaderNavigation({ reader }: { readonly reader: Reader }) {
  const doc = useReaderState(reader, (state) =>
    state.document.status === "ready" ? state.document.doc : null,
  );
  return doc?.kind === "pdf" ? <Pages key={doc.identity} reader={reader} /> : doc?.kind === "text" ? <Sections reader={reader} /> : null;
}

function Sections({ reader }: { readonly reader: Reader }) {
  const ready = useReaderState(reader, (state) =>
    state.document.status === "ready" && state.document.doc.kind === "text" ? state.document : null,
  );
  const current = useReaderState(reader, (state) =>
    state.document.status === "ready" && state.viewport
      ? (state.document.structure.sectionAt(state.viewport.primary)?.id ?? null)
      : null,
  );
  const sections = useMemo(
    () => ready?.doc.kind === "text"
      ? [...ready.doc.sections].sort((a, b) =>
          ready.structure.fraction({ kind: "text", ...a.at }) - ready.structure.fraction({ kind: "text", ...b.at }),
        )
      : [],
    [ready],
  );
  if (sections.length === 0) return null;
  const index = sections.findIndex((section) => section.id === current);
  const go = (at: number) => {
    const section = sections[at];
    if (section)
      void reader.inspect({ target: { kind: "point", point: { kind: "text", ...section.at } } });
  };
  return (
    <div className={styles.navigation}>
      <div className={styles.row}>
        <div className={styles.position}>
          <Button variant="ghost" size="sm" iconOnly aria-label="Previous section" title="Previous section" disabled={index <= 0} onClick={() => go(index - 1)}>
            <ChevronLeft size={16} aria-hidden="true" />
          </Button>
          <span className={styles.count} aria-label={index < 0 ? `Before the first of ${sections.length} sections` : `Section ${index + 1} of ${sections.length}`}>
            {index < 0 ? "—" : index + 1} / {sections.length}
          </span>
          <Button variant="ghost" size="sm" iconOnly aria-label="Next section" title="Next section" disabled={index >= sections.length - 1} onClick={() => go(index + 1)}>
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
        </div>
        <Select size="sm" className={styles.section} aria-label="Select section" value={current ?? ""} title={sections[index]?.label} onChange={(event) => go(sections.findIndex((section) => section.id === event.currentTarget.value))}>
          <option value="" disabled>Select section</option>
          {sections.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}
        </Select>
      </div>
    </div>
  );
}

function Pages({ reader }: { readonly reader: Reader }) {
  const pdf = useReaderState(reader, (state) => state.pdf);
  const atEnd = useReaderState(reader, (state) => state.viewport?.atEnd ?? false);
  const errorId = useId();
  const totalId = useId();
  const [draft, setDraft] = useState<{ readonly page: number; readonly value: string; readonly error: string | null } | null>(null);
  if (draft && draft.page !== pdf?.page) setDraft(null);
  if (!pdf) return null;
  const current = draft?.page === pdf.page ? draft : null;
  const go = (page: number) => void reader.inspect({ target: { kind: "point", point: { kind: "pdf", page, y: 0 } } });
  return (
    <div className={styles.navigation}>
      <div className={styles.row}>
        <div className={styles.position}>
          <Button variant="ghost" size="sm" iconOnly aria-label="Previous page" title="Previous page" disabled={pdf.page <= 1} onClick={() => go(pdf.page - 1)}>
            <ChevronLeft size={16} aria-hidden="true" />
          </Button>
          <label className={styles.page}>
            <span>Page</span>
            <Input
              size="sm"
              className={styles.pageInput}
              style={{ inlineSize: `${Math.max(2, String(pdf.pages).length) + 5}ch` }}
              type="number"
              inputMode="numeric"
              min={1}
              max={pdf.pages}
              step={1}
              aria-label="Page"
              aria-describedby={current?.error ? `${totalId} ${errorId}` : totalId}
              aria-invalid={current?.error ? true : undefined}
              aria-keyshortcuts="Enter Escape"
              value={current?.value ?? String(pdf.page)}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setDraft({ page: pdf.page, value: event.currentTarget.value, error: null })}
              onBlur={() => setDraft(null)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setDraft(null);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const value = current?.value ?? String(pdf.page);
                  const page = Number(value);
                  if (!/^\d+$/.test(value) || !Number.isInteger(page) || page < 1 || page > pdf.pages) {
                    setDraft({ page: pdf.page, value, error: `Enter a page from 1 to ${pdf.pages}.` });
                    return;
                  }
                  setDraft(null);
                  go(page);
                }
              }}
            />
            <span id={totalId}>/ {pdf.pages}</span>
          </label>
          <Button variant="ghost" size="sm" iconOnly aria-label="Next page" title="Next page" disabled={pdf.page >= pdf.pages || atEnd} onClick={() => go(pdf.page + 1)}>
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
        </div>
        <ActionMenu
          label="Zoom"
          renderTrigger={(trigger) => <Button {...trigger} className={styles.zoom} variant="ghost" size="sm">Zoom</Button>}
          options={[
            { kind: "command", id: "zoom-out", label: "Zoom out", disabled: pdf.scale <= PDF_ZOOM.min, onSelect: () => reader.setZoom(pdf.scale - PDF_ZOOM.step) },
            { kind: "command", id: "zoom-in", label: "Zoom in", disabled: pdf.scale >= PDF_ZOOM.max, onSelect: () => reader.setZoom(pdf.scale + PDF_ZOOM.step) },
          ]}
        />
      </div>
      {current?.error ? <FieldFeedback id={errorId} content={{ tone: "Danger", title: current.error }} /> : null}
    </div>
  );
}
