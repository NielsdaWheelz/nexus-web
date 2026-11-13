"use client";

import * as Icon from "@/lib/ui/icons";
import { useId, useMemo, useState } from "react";
import { Field } from "@/components/feedback/Fact";
import Button from "@/components/ui/Button";
import { buttonClassName } from "@/components/ui/control";
import Input from "@/components/ui/Input";
import ActionMenu from "@/components/ui/ActionMenu";
import Tooltip from "@/components/ui/Tooltip";
import { codepointToUtf16 } from "@/lib/canonicalText/codepoints";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { workspaceTargetActivationIntent, type OpenIntent } from "@/lib/ui/targetActivation";
import { useReaderState, type Reader, type ReaderState } from "../DocumentReader";
import { PDF_ZOOM, sourceTarget, type Section } from "../model";
import { activateReaderDestination, ReaderLink } from "../navigation";
import styles from "./ReaderNavigation.module.css";

/** The running head's controls know the publication, never their placement. */
export default function ReaderNavigation({ reader }: { readonly reader: Reader }) {
  const doc = useReaderState(reader, (state) =>
    state.document.status === "ready" ? state.document.doc : null,
  );
  return doc?.kind === "pdf" ? <Pages key={doc.identity} reader={reader} /> : doc?.kind === "text" ? <Sections reader={reader} /> : null;
}

interface PlacedSection {
  readonly section: Section;
  readonly start: number;
  readonly target: { readonly kind: "point"; readonly point: { readonly kind: "text"; readonly unit: string; readonly offset: number } };
}

function readingFraction(state: ReaderState): number | null {
  return state.document.status === "ready" && state.viewport
    ? state.document.structure.fraction(state.viewport.primary) : null;
}

function Sections({ reader }: { readonly reader: Reader }) {
  const ready = useReaderState(reader, (state) =>
    state.document.status === "ready" && state.document.doc.kind === "text" ? state.document : null,
  );
  const current = useReaderState(reader, (state) =>
    state.document.status === "ready" && state.viewport
      ? state.document.structure.sectionAt(state.viewport.primary) : null,
  );
  const transcript = ready?.doc.kind === "text" && ready.doc.format === "transcript";
  const order = useMemo<readonly PlacedSection[]>(() => ready?.doc.kind === "text"
    ? ready.doc.sections.flatMap(section => {
        if (section.at === null) return [];
        const target = { kind: "point" as const, point: { kind: "text" as const, ...section.at } };
        return [{ section, target, start: ready.structure.fraction(target.point) }];
      }).sort((a, b) => a.start - b.start)
    : [], [ready]);
  const sections = useMemo(() => ready?.doc.kind === "text"
    ? transcript ? ready.doc.sections : order.map(entry => entry.section)
    : [], [order, ready, transcript]);
  const placed = order.find(entry => entry.section.id === current?.id) ?? null;
  const onPage = useMemo(() => {
    if (transcript || !current?.at || !ready) return false;
    const unit = ready.structure.unit(current.at.unit);
    if (!unit) return false;
    const words = unit.text.slice(codepointToUtf16(unit.text, current.at.offset)).replace(/\s+/gu, " ").trim();
    const label = current.label.replace(/\s+/gu, " ").trim();
    return label.length > 0 && (words === label || words.startsWith(`${label} `));
  }, [current, ready, transcript]);
  const yielded = useReaderState(reader, state =>
    onPage && placed !== null && state.viewport !== null && placed.start >= state.viewport.start,
  );
  if (!ready || sections.length === 0) return null;
  const index = sections.findIndex(section => section.id === current?.id);
  const noun = transcript ? "chapter" : "section";
  const label = current?.label ?? (transcript ? "chapters" : "contents");
  const options: ActionDescriptor[] = sections.map(section => {
    const location = section.id === current?.id ? "location" as const : undefined;
    if (section.at === null) return { kind: "command", id: section.id, label: section.label, icon: null, current: location,
      disabled: true, disabledReason: "no transcript at this time.", onSelect: () => {} };
    const to = { kind: "point" as const, point: { kind: "text" as const, ...section.at } };
    const portable = sourceTarget(ready.doc, to);
    if (portable === null) throw new Error("section point is outside its reading body");
    const destination = { source_identity: ready.doc.identity, target: portable };
    const href = reader.navigation?.href(destination);
    const local = () => {
      void reader.inspect({ target: to });
      reader.focusSource();
    };
    return href ? { kind: "link", id: section.id, label: section.label, icon: null, current: location, href,
      onActivate: event => activateReaderDestination(reader, destination, event, local) }
      : { kind: "command", id: section.id, label: section.label, icon: null, current: location, onSelect: ({ openIntent }) => reader.navigation ? reader.navigation.activate(destination, openIntent, local) : local() };
  });
  return (
    <div className={styles.navigation}>
      <div className={styles.row}>
        <ActionMenu
          label={`${label}; select ${noun}`}
          className={styles.section}
          source={{ kind: "Immediate", subjectKey: `reader-sections:${ready.doc.identity}`, title: `${noun}s`,
            content: { sections: [{ id: "Sections", label: null, options }] } }}
          renderTrigger={props => (
            <Button {...props} className={styles.sectionTrigger} data-yielded={yielded || undefined}>
              <span className={styles.sectionContent}>
                {transcript ? <Icon.Chapters size={16} className={styles.sign} aria-hidden="true" /> : <Icon.Contents size={16} className={styles.sign} aria-hidden="true" />}
                <span className={styles.title}>{label}</span>
              </span>
            </Button>
          )}
        />
        <Folio reader={reader} noun={noun} index={index} total={sections.length} />
        <SectionSteps reader={reader} order={order} noun={noun} />
      </div>
      <SectionGauge reader={reader} order={order} current={placed} noun={noun} />
    </div>
  );
}

function Folio({ reader, noun, index, total }: {
  readonly reader: Reader;
  readonly noun: string;
  readonly index: number;
  readonly total: number;
}) {
  const percent = useReaderState(reader, state => state.viewport?.atEnd ? 100 : Math.round((readingFraction(state) ?? 0) * 100));
  return <span className={styles.folio}>
    <span className="sr-only">{index < 0 ? `${total} ${noun}s` : `${noun} ${index + 1} of ${total}`}; {percent}% through document</span>
    <span className={styles.folioDigits} aria-hidden="true">{percent}%</span>
  </span>;
}

function SectionGauge({ reader, order, current, noun }: {
  readonly reader: Reader;
  readonly order: readonly PlacedSection[];
  readonly current: PlacedSection | null;
  readonly noun: string;
}) {
  const here = useReaderState(reader, readingFraction);
  const end = current ? order.find(entry => entry.start > current.start)?.start ?? 1 : 1;
  const through = current && here !== null && end > current.start
    ? Math.max(0, Math.min(1, (here - current.start) / (end - current.start))) : 0;
  return <span className={styles.gauge} role="img" aria-label={current ? `${Math.round(through * 100)}% through this ${noun}` : `not in a ${noun}`}>
    <span className={styles.gaugeFill} aria-hidden="true" style={{ inlineSize: `${through * 100}%` }} />
  </span>;
}

function SectionSteps({ reader, order, noun }: {
  readonly reader: Reader;
  readonly order: readonly PlacedSection[];
  readonly noun: string;
}) {
  const viewport = useReaderState(reader, state => state.viewport);
  const here = useReaderState(reader, readingFraction);
  const enclosing = here === null ? null : order.findLast(entry => entry.start <= here) ?? null;
  const toStart = enclosing !== null && viewport !== null && enclosing.start < viewport.start;
  const up = toStart ? enclosing : enclosing ? order.findLast(entry => entry.start < enclosing.start) ?? null : null;
  const down = here === null || viewport?.atEnd ? null : order.find(entry => entry.start > here) ?? null;
  const upName = toStart ? `Start of this ${noun}` : `Previous ${noun}`;
  return <div className={styles.steps}>
    {order.length === 0 ? <Button iconOnly icon={<Icon.Up size={16} />} className={styles.step} disabled aria-label={upName} /> : <Tooltip text={upName} renderTrigger={help => (
      <ReaderLink {...help} reader={reader} target={(up ?? order[0]).target} disabled={!up} className={`${buttonClassName({ iconOnly: true })} ${styles.step}`} aria-label={upName}><Icon.Up size={16} aria-hidden="true" /></ReaderLink>
    )} />}
    {order.length === 0 ? <Button iconOnly icon={<Icon.Down size={16} />} className={styles.step} disabled aria-label={`Next ${noun}`} /> : <Tooltip text={`Next ${noun}`} renderTrigger={help => (
      <ReaderLink {...help} reader={reader} target={(down ?? order[order.length - 1]).target} disabled={!down} className={`${buttonClassName({ iconOnly: true })} ${styles.step}`} aria-label={`Next ${noun}`}><Icon.Down size={16} aria-hidden="true" /></ReaderLink>
    )} />}
  </div>;
}

function Pages({ reader }: { readonly reader: Reader }) {
  const pdf = useReaderState(reader, state => state.pdf);
  const atEnd = useReaderState(reader, state => state.viewport?.atEnd ?? false);
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
      setDraft({ page: pdf.page, value, error: `pages run from 1 to ${pdf.pages}.` });
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
  const zoom = Math.round(pdf.scale * 100);
  return (
    <div className={styles.navigation}>
      <div className={styles.row}>
        <label className={styles.page}>
          <span className={styles.pageWord}>page</span>
          <Input
            bare
            size="sm"
            className={styles.pageInput}
            style={{ inlineSize: `${Math.max(2, String(pdf.pages).length) + 1}ch` }}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            aria-label="page"
            aria-describedby={current?.error ? `${totalId} ${errorId}` : totalId}
            aria-invalid={current?.error ? true : undefined}
            aria-keyshortcuts="Enter Escape"
            value={current?.value ?? String(pdf.page)}
            onFocus={event => event.currentTarget.select()}
            onChange={event => setDraft({ page: pdf.page, value: event.currentTarget.value, error: null })}
            onBlur={() => setDraft(null)}
            onKeyDown={event => {
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
          <span id={totalId} className={styles.pageTotal}>of {pdf.pages}</span>
        </label>
        <div className={styles.zoom} role="group" aria-label="pdf zoom">
          <Button iconOnly icon={<Icon.ZoomOut size={16} />} aria-label="zoom out" disabled={pdf.scale <= PDF_ZOOM.min} onClick={() => reader.setZoom(pdf.scale - PDF_ZOOM.step)} />
          <Button className={styles.zoomState} aria-label={pdf.zoom === null ? "fit pdf to width; fitted" : `fit pdf to width; zoom ${zoom}%`} aria-disabled={pdf.zoom === null} onClick={() => reader.setZoom(null)}>
            {pdf.zoom === null ? "fitted" : `${zoom}%`}
          </Button>
          <Button iconOnly icon={<Icon.ZoomIn size={16} />} aria-label="zoom in" disabled={pdf.scale >= PDF_ZOOM.max} onClick={() => reader.setZoom(pdf.scale + PDF_ZOOM.step)} />
        </div>
        <div className={`${styles.steps} ${styles.pageSteps}`}>
          <Tooltip text="Previous page" renderTrigger={help => (
            <ReaderLink {...help} reader={reader} target={target(Math.max(1, pdf.page - 1))} className={`${buttonClassName({ iconOnly: true })} ${styles.step}`} aria-label="Previous page" disabled={pdf.page <= 1}><Icon.Up size={16} aria-hidden="true" /></ReaderLink>
          )} />
          <Tooltip text="Next page" renderTrigger={help => (
            <ReaderLink {...help} reader={reader} target={target(Math.min(pdf.pages, pdf.page + 1))} className={`${buttonClassName({ iconOnly: true })} ${styles.step}`} aria-label="Next page" disabled={pdf.page >= pdf.pages || atEnd}><Icon.Down size={16} aria-hidden="true" /></ReaderLink>
          )} />
        </div>
      </div>
      {current?.error ? <Field id={errorId} line={{ fact: current.error }} /> : null}
    </div>
  );
}
