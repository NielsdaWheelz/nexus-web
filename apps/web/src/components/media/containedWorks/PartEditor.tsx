"use client";

// A visit retains authored input and the exact unconfirmed command. Preview is
// transient, read-only and keyed to the current detector selection.
import { useEffect, useState } from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import SelectField from "@/components/ui/SelectField";
import { isApiError, isRefusal } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import { previewPart, savePart } from "@/lib/media/parts";
import { isAbortError } from "@/lib/errors";
import styles from "./parts.module.css";

type Navigation = Schema<"MediaNavigationOut">;
type Draft = {
  title: string; first: string; last: string; form: Schema<"PartCreate">["form"] | null;
  baseline: string; request: { id: string | null; body: Schema<"PartCreate"> | Schema<"PartUpdate"> } | null;
  busy: boolean; error: string | null;
};
export function partError(error: unknown): string {
  if (!isApiError(error)) throw error;
  if (error.status === 409) return "this piece or its source changed. review the current sections and try again.";
  if (error.status === 400) return error.message;
  if (error.status === 403 || error.status === 404) return "this piece is no longer available to change.";
  return "this request couldn’t be confirmed. try the same request again.";
}

export default function PartEditor({ source, initialSection, navigation, page, definition, onClose, onSaved }: {
  readonly source: string; readonly initialSection: string; readonly navigation: Navigation | null;
  readonly page: Schema<"PartPage"> | null; readonly definition: Schema<"PartDefinition"> | null;
  readonly onClose: () => void; readonly onSaved: () => void;
}) {
  const initialTitle = definition?.title ?? navigation?.sections.find(section => section.section_id === initialSection)?.label ?? "";
  const initialForm = definition?.form ?? null;
  const firstSelection = definition?.selection?.section_ids[0] ?? initialSection;
  const lastSelection = definition?.selection?.section_ids.at(-1) ?? initialSection;
  const initial = { title: initialTitle, first: firstSelection, last: lastSelection, form: initialForm };
  const state = useResourceDraft<Draft>(`piece:${definition?.media_id ?? source}:${initialSection}`, () => ({
    ...initial, baseline: JSON.stringify(initial), request: null, busy: false, error: null,
  }), value => ({ changed: JSON.stringify({ title: value.title, first: value.first, last: value.last, form: value.form }) !== value.baseline,
    unconfirmed: value.request !== null, stopsBrowserWork: false }));
  const { title, first, last, form, busy, request, error } = state.value;
  const guard = useWorkGuard();
  const bounds = navigation !== null && page !== null && page.navigation_key !== null && page.source_generation !== null;
  const choices = page?.section_choices ?? [];
  const eligible = (section: string) => choices.some(choice => choice.section_id === section && choice.eligible);
  const start = navigation?.sections.find(section => section.section_id === first) ?? null;
  const ends: Navigation["sections"] = [];
  if (start !== null && navigation !== null && eligible(first)) {
    let previous = start;
    ends.push(start);
    const siblings = navigation.sections.filter(section => section.parent_section_id === start.parent_section_id);
    for (const candidate of siblings.slice(siblings.indexOf(start) + 1)) {
      const end = previous.extent?.end;
      const at = candidate.extent?.start;
      if (!eligible(candidate.section_id) || !end || !at) break;
      const endIndex = navigation.fragments.findIndex(fragment => fragment.fragment_id === end.fragment_id);
      const atIndex = navigation.fragments.findIndex(fragment => fragment.fragment_id === at.fragment_id);
      const adjacent = end.fragment_id === at.fragment_id && end.offset === at.offset ||
        endIndex >= 0 && atIndex === endIndex + 1 && end.offset === navigation.fragments[endIndex].char_count && at.offset === 0;
      if (!adjacent) break;
      ends.push(candidate);
      previous = candidate;
    }
  }
  const endIndex = ends.findIndex(section => section.section_id === last);
  const selector = bounds && endIndex >= 0 ? {
    source_generation: page!.source_generation!, navigation_key: page!.navigation_key!,
    section_ids: ends.slice(0, endIndex + 1).map(section => section.section_id),
  } : null;
  const selectionKey = selector === null ? null : JSON.stringify(selector);
  const [preview, setPreview] = useState<{ key: string; document: Schema<"ReaderPartDocumentOut"> } | null>(null);
  const [previewFailure, setPreviewFailure] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => {
    if (selectionKey === null) return;
    const controller = new AbortController();
    setPreviewFailure(null);
    // selectionKey is the exact same-system selector serialized above.
    const selection: Schema<"SectionSelection"> = JSON.parse(selectionKey);
    void previewPart(source, selection, controller.signal).then(document => {
      if (!controller.signal.aborted) { setPreview({ key: selectionKey, document }); setPreviewFailure(null); }
    }).catch(error => {
      if (!controller.signal.aborted && !isAbortError(error)) setPreviewFailure({ key: selectionKey, message: partError(error) });
    });
    return () => controller.abort();
  }, [selectionKey, source]);
  const currentPreview = preview?.key === selectionKey ? preview.document : null;
  const currentFailure = previewFailure?.key === selectionKey ? previewFailure.message : null;
  const confirmedSelection = definition !== null && definition.selection === null ? null : selector;
  const unchangedBounds = definition !== null && definition.selection !== null && JSON.stringify(definition.selection.section_ids) === JSON.stringify(selector?.section_ids);
  const submit = async () => {
    const current = state.read();
    if (current.busy || current.title.trim() === "" || bounds && currentPreview === null && current.request === null) return;
    const sent = current.request ?? { id: definition?.media_id ?? null, body: definition === null
      ? { id: crypto.randomUUID(), title: current.title, form: current.form, selection: selector! }
      : { expected_version: definition.version, title: current.title, form: current.form, selection: unchangedBounds ? null : confirmedSelection } };
    state.set(value => ({ ...value, request: sent, busy: true, error: null }));
    try {
      await savePart(source, sent.id, sent.body);
      state.set(value => ({ ...value, request: null, busy: false, baseline: JSON.stringify({ title: value.title, first: value.first, last: value.last, form: value.form }) }));
      onSaved();
      onClose();
    } catch (failure) {
      state.set(value => ({ ...value, busy: false, request: isRefusal(failure) ? null : sent, error: partError(failure) }));
    }
  };
  const label = definition === null ? "read separately" : "edit piece";
  const blocking = busy || request !== null;
  return <Dialog open title={label} onClose={onClose}
    onDismissRequest={() => guard.confirmLoss({ scopes: [], ownerIds: [state.owner] }) ? "accepted" : "blocked"}>
    <div className={styles.editor}>
      <label>title<Input value={title} disabled={blocking} onChange={event => state.set(value => ({ ...value, title: event.target.value }))} /></label>
      <SelectField layout="Stacked" label="form" value={form ?? ""} disabled={blocking}
        onChange={event => { const form = event.target.value; state.set(value => ({ ...value, form: (["essay", "poem", "letter", "short_story", "section"] as const).find(candidate => candidate === form) ?? null })); }}>
        <option value="">unknown</option>{["essay", "poem", "letter", "short_story", "section"].map(form => <option key={form} value={form}>{form.replace("_", " ")}</option>)}
      </SelectField>
      {bounds ? <>
        <SelectField layout="Stacked" label="first section" value={first} disabled={blocking} onChange={event => {
          const first = event.target.value; state.set(value => ({ ...value, first, last: first }));
        }}>{navigation!.sections.map(section => <option key={section.section_id} value={section.section_id} disabled={!eligible(section.section_id)}>{section.label}</option>)}</SelectField>
        <SelectField layout="Stacked" label="last section" value={last} disabled={blocking} onChange={event => state.set(value => ({ ...value, last: event.target.value }))}>
          {ends.map(section => <option key={section.section_id} value={section.section_id}>{section.label}</option>)}
        </SelectField>
        {definition ? <p>changing these sections also changes this piece’s shared links.</p> : null}
        {currentFailure ? <p role="alert">{currentFailure}</p> : currentPreview ?
          <section aria-label="included text" className={styles.preview} onClickCapture={event => {
            if (event.target instanceof Element && event.target.closest("a")) event.preventDefault();
          }}>{currentPreview.units.map(unit => <HtmlRenderer key={unit.id} htmlSanitized={unit.html_sanitized} headingLevelOffset={2} />)}</section>
          : <p role="status">preparing included text…</p>}
      </> : null}
      {error ? <p role="alert">{error}</p> : null}
      <Button emphasis="strong" disabled={busy || title.trim() === "" || bounds && currentPreview === null && request === null}
        aria-busy={busy} onClick={() => void submit()}>{request !== null && !busy ? "try same request again" : label}</Button>
    </div>
  </Dialog>;
}
