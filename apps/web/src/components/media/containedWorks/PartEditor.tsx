"use client";

// A visit retains authored input and the exact unconfirmed command. Preview is
// transient, read-only and keyed to the current detector selection.
import { useEffect, useState } from "react";
import HtmlRenderer from "@/components/HtmlRenderer";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import SelectField from "@/components/ui/SelectField";
import { captureApiAccount, isCurrentApiAccount, isApiError, isRefusal } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import type { Schema } from "@/lib/api/wire";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import { partDefinition, previewPart, savePart } from "@/lib/media/parts";
import { isAbortError } from "@/lib/errors";
import styles from "./parts.module.css";

type Navigation = Schema<"MediaNavigationOut">;
type Draft = {
  title: string; first: string; last: string;
  baseline: string; request: { id: string | null; body: Schema<"PartCreate"> | Schema<"PartUpdate"> } | null;
  definition: Schema<"PartDefinition"> | null; conflict: boolean; saved: Schema<"PartDefinition"> | null;
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
  const firstSelection = definition?.selection?.section_ids[0] ?? initialSection;
  const lastSelection = definition?.selection?.section_ids.at(-1) ?? initialSection;
  const initial = { title: initialTitle, first: firstSelection, last: lastSelection };
  const state = useResourceDraft<Draft>(definition === null ? `piece:${source}:${initialSection}` : `piece:${definition.media_id}`, () => ({
    ...initial, baseline: JSON.stringify(initial), definition, conflict: false, saved: null, request: null, busy: false, error: null,
  }), value => ({ changed: JSON.stringify({ title: value.title, first: value.first, last: value.last }) !== value.baseline,
    unconfirmed: value.request !== null, stopsBrowserWork: false }));
  const { title, first, last, busy, request, error, conflict, saved } = state.value;
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
  const baselineDefinition = state.value.definition;
  const unchangedBounds = baselineDefinition !== null && baselineDefinition.selection !== null && JSON.stringify(baselineDefinition.selection.section_ids) === JSON.stringify(selector?.section_ids);
  const loadSaved = async () => {
    if (definition === null) return;
    const account = captureApiAccount();
    try {
      const saved = await partDefinition(definition.media_id, new AbortController().signal);
      if (isCurrentApiAccount(account)) state.set(value => ({ ...value, saved }));
    } catch (failure) {
      if (isCurrentApiAccount(account)) state.set(value => ({ ...value, error: partError(failure) }));
    }
  };
  const keepChanges = async () => {
    if (saved === null || (bounds && selector === null)) return;
    const account = captureApiAccount();
    state.set(value => ({ ...value, busy: true, error: null }));
    try {
      if (selector !== null) await previewPart(source, selector, new AbortController().signal);
      if (isCurrentApiAccount(account)) state.set(value => ({ ...value, definition: saved, conflict: false, saved: null, busy: false }));
    } catch (failure) {
      if (isCurrentApiAccount(account)) state.set(value => ({ ...value, busy: false, error: partError(failure) }));
    }
  };
  const submit = async () => {
    const current = state.read();
    if (current.busy || current.conflict || current.title.trim() === "" || bounds && currentPreview === null && current.request === null) return;
    const sent = current.request ?? { id: definition?.media_id ?? null, body: definition === null
      ? { id: crypto.randomUUID(), title: current.title, selection: selector! }
      : { expected_version: current.definition!.version, title: current.title, selection: unchangedBounds ? null : selector } };
    const account = captureApiAccount();
    state.set(value => ({ ...value, request: sent, busy: true, error: null }));
    try {
      const receipt = await savePart(source, sent.id, sent.body);
      if (!isCurrentApiAccount(account)) return;
      state.set(value => ({ ...value, request: null, busy: false,
        definition: value.definition !== null && "expected_version" in sent.body
          ? { ...value.definition, version: receipt.version, title: sent.body.title,
              selection: sent.body.selection ?? value.definition.selection }
          : value.definition,
        baseline: JSON.stringify({ title: value.title, first: value.first, last: value.last }) }));
      onSaved();
      onClose();
    } catch (failure) {
      if (!isCurrentApiAccount(account)) return;
      if (definition !== null && isApiError(failure) && failure.status === 409) {
        state.set(value => ({ ...value, busy: false, request: null, conflict: true, saved: null, error: partError(failure) }));
        publishChange("Metadata");
        await loadSaved();
      } else {
        state.set(value => ({ ...value, busy: false, request: isRefusal(failure) ? null : sent, error: partError(failure) }));
      }
    }
  };
  const label = definition === null ? "read separately" : "edit piece";
  const blocking = busy || request !== null;
  return <Dialog open title={label} onClose={onClose}
    onDismissRequest={() => guard.confirmLoss({ scopes: [], ownerIds: [state.owner] }) ? "accepted" : "blocked"}>
    <div className={styles.editor}>
      <label>title<Input value={title} disabled={blocking} onChange={event => state.set(value => ({ ...value, title: event.target.value }))} /></label>
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
      {conflict && saved ? <section aria-label="current saved piece">
        <h3>current saved piece</h3>
        <p>title: {saved.title}</p>
        <p>extent: {saved.selection?.section_ids.map(id => navigation?.sections.find(section => section.section_id === id)?.label ?? "section no longer available").join(" – ") ?? "saved passage"}</p>
        <Button disabled={busy || bounds && currentPreview === null} onClick={() => void keepChanges()}>keep my changes</Button>
      </section> : conflict ? <Button onClick={() => void loadSaved()}>retry loading current piece</Button> : null}
      <Button emphasis="strong" disabled={busy || conflict || title.trim() === "" || bounds && currentPreview === null && request === null}
        aria-busy={busy} onClick={() => void submit()}>{request !== null && !busy ? "try same request again" : label}</Button>
    </div>
  </Dialog>;
}
