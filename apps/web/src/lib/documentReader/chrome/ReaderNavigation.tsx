"use client";

import { useId, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { FieldFeedback } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import ActionMenu from "@/components/ui/ActionMenu";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { workspaceTargetActivationIntent, type OpenIntent } from "@/lib/ui/targetActivation";
import { useReaderState, type Reader } from "../DocumentReader";
import { PDF_ZOOM } from "../model";
import { activateReaderDestination, ReaderLink } from "../navigation";
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
  const target = (at: number) => ({ kind: "point" as const, point: { kind: "text" as const, ...sections[Math.max(0, Math.min(at, sections.length - 1))].at } });
  const options: ActionDescriptor[] = sections.map((section, at) => {
    const destination = { source_identity: ready!.doc.identity, target: target(at) };
    const href = reader.navigation?.href(destination);
    const local = () => {
      void reader.inspect({ target: destination.target });
      reader.focusSource();
    };
    return href ? { kind: "link", id: section.id, label: section.label, href,
      onActivate: (event) => activateReaderDestination(reader, destination, event, local) }
      : { kind: "command", id: section.id, label: section.label, onSelect: ({ openIntent }) => reader.navigation ? reader.navigation.activate(destination, openIntent, local) : local() };
  });
  return (
    <div className={styles.navigation}>
      <div className={styles.row}>
        <div className={styles.position}>
          <Button variant="ghost" size="sm" iconOnly asChild>
            <ReaderLink reader={reader} target={target(index - 1)} aria-label="Previous section" title="Previous section" disabled={index <= 0}><ChevronLeft size={16} aria-hidden="true" /></ReaderLink>
          </Button>
          <span className={styles.count} aria-label={index < 0 ? `Before the first of ${sections.length} sections` : `Section ${index + 1} of ${sections.length}`}>
            {index < 0 ? "—" : index + 1} / {sections.length}
          </span>
          <Button variant="ghost" size="sm" iconOnly asChild>
            <ReaderLink reader={reader} target={target(index + 1)} aria-label="Next section" title="Next section" disabled={index >= sections.length - 1}><ChevronRight size={16} aria-hidden="true" /></ReaderLink>
          </Button>
        </div>
        <ActionMenu label="select section" className={styles.section}
          source={{ kind: "Immediate", subjectKey: `reader-sections:${ready!.doc.identity}`, title: "sections",
            content: { sections: [{ id: "Sections", label: null, options }] } }} renderTrigger={(props) => <Button {...props} variant="ghost" size="sm">{sections[index]?.label ?? "Select section"}</Button>} />
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
  const target = (page: number) => ({ kind: "pdf" as const, page, view: { kind: "page_top" as const, zoom: pdf.zoom } });
  const submit = (intent: OpenIntent) => {
    const value = current?.value ?? String(pdf.page);
    const page = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(page) || page < 1 || page > pdf.pages) {
      setDraft({ page: pdf.page, value, error: `Enter a page from 1 to ${pdf.pages}.` });
      return;
    }
    setDraft(null);
    const doc = reader.getState().document;
    if (doc.status !== "ready") return;
    const destination = { source_identity: doc.doc.identity, target: target(page) };
    const local = () => void reader.inspect({ target: destination.target });
    if (reader.navigation) reader.navigation.activate(destination, intent, local);
    else local();
  };
  return (
    <div className={styles.navigation}>
      <div className={styles.row}>
        <div className={styles.position}>
          <Button variant="ghost" size="sm" iconOnly asChild>
            <ReaderLink reader={reader} target={target(Math.max(1, pdf.page - 1))} aria-label="Previous page" title="Previous page" disabled={pdf.page <= 1}><ChevronLeft size={16} aria-hidden="true" /></ReaderLink>
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
                } else {
                  const activation = workspaceTargetActivationIntent(event, "activate");
                  if (activation.kind === "Unowned") return;
                  event.preventDefault();
                  if (activation.kind === "Open") submit(activation.intent);
                }
              }}
            />
            <span id={totalId}>/ {pdf.pages}</span>
          </label>
          <Button variant="ghost" size="sm" iconOnly asChild>
            <ReaderLink reader={reader} target={target(Math.min(pdf.pages, pdf.page + 1))} aria-label="Next page" title="Next page" disabled={pdf.page >= pdf.pages || atEnd}><ChevronRight size={16} aria-hidden="true" /></ReaderLink>
          </Button>
        </div>
        <div className={styles.zoom} role="group" aria-label="pdf zoom">
          <Button variant="ghost" size="sm" iconOnly aria-label="zoom out" title="zoom out" disabled={pdf.scale <= PDF_ZOOM.min} onClick={() => reader.setZoom(pdf.scale - PDF_ZOOM.step)}>
            <Minus size={16} aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="sm" aria-label={`fit pdf to width; current zoom ${Math.round(pdf.scale * 100)} percent`} onClick={() => reader.setZoom(null)}>
            {pdf.zoom === null ? "fit width" : `${Math.round(pdf.scale * 100)}% · fit width`}
          </Button>
          <Button variant="ghost" size="sm" iconOnly aria-label="zoom in" title="zoom in" disabled={pdf.scale >= PDF_ZOOM.max} onClick={() => reader.setZoom(pdf.scale + PDF_ZOOM.step)}>
            <Plus size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
      {current?.error ? <FieldFeedback id={errorId} content={{ tone: "Danger", title: current.error }} /> : null}
    </div>
  );
}
