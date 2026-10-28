"use client";

// The draft owns its baseline/version and exact unconfirmed command. Preparation
// changes available geometry, never the user's title or a reviewed generation.
// A confirmed save stays busy until refresh and close settle together.
import { useEffect, useMemo, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import SelectField from "@/components/ui/SelectField";
import { captureApiAccount, isCurrentApiAccount, isApiError, isRefusal } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import { prepareParts, savePart } from "@/lib/media/parts";
import PartPreview, { usePartPreview } from "./PartPreview";
import styles from "./parts.module.css";

type Request = { kind: "prepare"; body: Schema<"PartPrepare"> }
  | { kind: "save"; id: string | null; body: Schema<"PartCreate"> | Schema<"PartUpdate"> };
type Draft = {
  title: string; first: string | null; last: string | null; generation: number | null;
  baseline: string; version: number | null; baselineSelection: Schema<"SectionSelection"> | null; request: Request | null;
  busy: boolean; error: string | null; conflict: boolean; retired: boolean;
};
export function partError(error: unknown): string {
  if (!isApiError(error)) throw error;
  if (error.status === 409) return "this work or its source changed. review the current sections and try again.";
  if (error.status === 400) return error.message;
  if (error.status === 403 || error.status === 404) return "this work is no longer available to change.";
  return "couldn’t confirm this request";
}
export function partBlockMessage(reason: Schema<"PartAction">["reason"]): string {
  switch (reason) {
    case "unknown_end": return "this section’s end hasn’t been identified";
    case "unproved_structure": return "this section can’t be extracted without losing content";
    case "navigation_changed": return "the sections changed. choose from the current contents";
    case "missing_title": return "choose a title before extracting";
    case "existing_piece": return "this range already belongs to an extracted work";
    case "bound_candidate": return "this range already belongs to a work whose sections changed";
    case "preparing_structure": return "prepare text before extracting this section";
    case "not_creator": return "only the source creator can extract works";
    case "unsupported_source": return "independent works aren’t available for this source";
    case "not_ready": return "the source text isn’t ready yet";
    case "active": return "extraction is already in progress";
    case null: return "this section is unavailable";
  }
}

export default function PartEditor({ source, initialSection, initialTitle, initialSelection = null, page, definition, onClose, onSaved, onRefresh, readFailure, readPending, returnFocusTo }: {
  readonly source: string; readonly initialSection: string | null; readonly initialTitle: string;
  readonly initialSelection?: Schema<"SectionSelection"> | null;
  readonly page: Schema<"SourceContentsOut"> | null; readonly definition: Schema<"PartDefinition"> | null;
  readonly onClose: () => void; readonly onSaved: (id: string) => Promise<void>;
  readonly onRefresh: () => Promise<void>; readonly readFailure: boolean; readonly readPending: boolean; readonly returnFocusTo: ReturnFocusTarget;
}) {
  const navigation = page?.navigation ?? null;
  const initial = useMemo(() => ({ title: definition?.title ?? initialTitle,
    first: definition?.selection?.section_ids[0] ?? initialSelection?.section_ids[0] ?? initialSection,
    last: definition?.selection?.section_ids.at(-1) ?? initialSelection?.section_ids.at(-1) ?? initialSection }), [definition, initialTitle, initialSection, initialSelection]);
  const state = useResourceDraft<Draft>(definition === null ? `extract:${source}:${initialSection}` : `work:${definition.media_id}`, () => ({
    ...initial, generation: definition?.selection?.source_generation ?? initialSelection?.source_generation ?? navigation?.generation ?? null,
    baseline: JSON.stringify(initial), version: definition?.version ?? null, baselineSelection: definition?.selection ?? null, request: null, busy: false, error: null, conflict: false, retired: false,
  }), value => ({ changed: JSON.stringify({ title: value.title, first: value.first, last: value.last }) !== value.baseline,
    unconfirmed: value.request !== null, stopsBrowserWork: false }));
  useEffect(() => {
    if (!state.read().retired) return;
    state.set({ ...initial, generation: definition?.selection?.source_generation ?? initialSelection?.source_generation ?? navigation?.generation ?? null,
      baseline: JSON.stringify(initial), version: definition?.version ?? null, baselineSelection: definition?.selection ?? null, request: null, busy: false, error: null, conflict: false, retired: false });
  }, [state, initial, definition, initialSelection, navigation]);
  const { title, first, last, busy, request, error, conflict } = state.value;
  const [adjacent, setAdjacent] = useState(first !== last);
  const [preparationStarted, setPreparationStarted] = useState(false);
  const guard = useWorkGuard();
  const canBounds = definition === null || definition.capabilities.edit_bounds.allowed;
  const choices = page?.section_choices ?? [];
  const eligible = (id: string) => choices.some(choice => choice.section_id === id && choice.eligible);
  const start = navigation?.sections.find(section => section.section_id === first) ?? null;
  const ends: Schema<"MediaNavigationOut">["sections"] = [];
  if (start && navigation && eligible(start.section_id)) {
    let previous = start;
    ends.push(start);
    const siblings = navigation.sections.filter(section => section.parent_section_id === start.parent_section_id);
    for (const candidate of siblings.slice(siblings.indexOf(start) + 1)) {
      const end = previous.extent?.end;
      const at = candidate.extent?.start;
      if (!eligible(candidate.section_id) || !end || !at) break;
      const endIndex = navigation.fragments.findIndex(fragment => fragment.fragment_id === end.fragment_id);
      const atIndex = navigation.fragments.findIndex(fragment => fragment.fragment_id === at.fragment_id);
      if (!(end.fragment_id === at.fragment_id && end.offset === at.offset || endIndex >= 0 && atIndex === endIndex + 1 && end.offset === navigation.fragments[endIndex].char_count && at.offset === 0)) break;
      ends.push(candidate);
      previous = candidate;
    }
  }
  const preparing = page?.preparation?.classification === "Active" && page.capabilities.create.reason === "preparing_structure";
  const needsPreparation = canBounds && page?.capabilities.create.reason === "preparing_structure";
  const endIndex = ends.findIndex(section => section.section_id === last);
  const selector: Schema<"SectionSelection"> | null = navigation && page?.navigation_key && endIndex >= 0 &&
    state.value.generation === navigation.generation && !preparing && !needsPreparation
    ? { source_generation: navigation.generation, navigation_key: page.navigation_key, section_ids: ends.slice(0, endIndex + 1).map(section => section.section_id) } : null;
  const preview = usePartPreview(source, canBounds ? selector : null);
  const previewConflict = preview.status === "ready" ? preview.data.creation_conflict : null;
  const blockedPreview = previewConflict !== null && !(definition !== null && (previewConflict.reason === "bound_candidate" || previewConflict.media_id === definition.media_id));
  const blocking = busy || request !== null;
  const run = async (sent: Request, retry = false) => {
    if (state.read().busy || state.read().request !== null && !retry) return;
    const account = captureApiAccount();
    state.set(value => ({ ...value, request: sent, busy: true, error: null }));
    let receipt: Schema<"PartReceipt"> | null = null;
    try {
      if (sent.kind === "prepare") await prepareParts(source, sent.body);
      else receipt = await savePart(source, sent.id, sent.body);
    } catch (failure) {
      if (!isCurrentApiAccount(account)) return;
      state.set(value => ({ ...value, busy: false, request: isRefusal(failure) ? null : sent,
        conflict: value.conflict || sent.kind === "save" && sent.id !== null && isApiError(failure) && failure.status === 409, error: partError(failure) }));
      if (isRefusal(failure)) { void onRefresh(); preview.revalidate(); }
      return;
    }
    if (!isCurrentApiAccount(account)) return;
    state.set(value => ({ ...value, request: null, busy: receipt !== null,
      version: receipt?.version ?? value.version,
      baselineSelection: sent.kind === "save" ? sent.body.selection ?? value.baselineSelection : value.baselineSelection,
      baseline: receipt === null ? value.baseline : JSON.stringify({ title: value.title, first: value.first, last: value.last }) }));
    if (receipt === null) { setPreparationStarted(true); await onRefresh(); }
    else { try { await onSaved(receipt.media_id); } finally { if (isCurrentApiAccount(account)) { state.set(value => ({ ...value, busy: false, retired: true })); onClose(); } } }
  };
  // Manual intent opens first. Only this owner admits its preparation command.
  useEffect(() => {
    if (state.read().retired || !needsPreparation || preparing || preparationStarted || page?.preparation?.classification === "NeedsAttention" || blocking || navigation === null) return;
    setPreparationStarted(true);
    void run({ kind: "prepare", body: { id: crypto.randomUUID(), expected_source_generation: navigation.generation } });
    // The current snapshot and retained request are checked before admission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsPreparation, preparing, preparationStarted, page?.preparation?.classification]);
  const chooseFirst = (id: string) => state.set(value => ({ ...value, first: id, last: id, generation: navigation?.generation ?? null, error: null }));
  const save = () => {
    const current = state.read();
    if (current.busy || current.request !== null || conflict || title.trim() === "" || canBounds && (selector === null || preview.status !== "ready" || preview.error !== null || blockedPreview)) return;
    const unchangedBounds = current.baselineSelection !== null && current.baselineSelection.source_generation === selector?.source_generation &&
      JSON.stringify(current.baselineSelection.section_ids) === JSON.stringify(selector?.section_ids);
    void run({ kind: "save", id: definition?.media_id ?? null, body: definition === null
      ? { id: crypto.randomUUID(), title: current.title, selection: selector! }
      : { expected_version: current.version!, title: current.title, selection: unchangedBounds || !canBounds ? null : selector } });
  };
  const freshChoice = canBounds && (!start || navigation?.generation !== state.value.generation);
  const savedLabels = definition?.selection?.section_ids.map(id => navigation?.sections.find(section => section.section_id === id)?.label ?? null) ?? null;
  return <Dialog open title={definition === null ? "extract work" : "edit work"} onClose={onClose} returnFocusTo={returnFocusTo}
    onDismissRequest={() => {
      if (state.read().busy && state.read().request === null) return "blocked";
      if (!guard.confirmLoss({ scopes: [], ownerIds: [state.owner] })) return "blocked";
      if (state.read().request === null) state.set(value => ({ ...value, retired: true, baseline: JSON.stringify({ title: value.title, first: value.first, last: value.last }) }));
      return "accepted";
    }}>
    <div className={styles.editor}>
      <label>title<Input value={title} disabled={blocking} onChange={event => state.set(value => ({ ...value, title: event.target.value }))} /></label>
      {canBounds ? <>
        {readFailure ? <><p role="alert">couldn’t load current sections</p><Button onClick={() => void onRefresh()}>try again</Button></> : page === null ? <p role="status">loading current sections…</p> : null}
        {preparing || needsPreparation && !error ? <p role="status">preparing text…</p> : null}
        {(page?.preparation?.classification === "NeedsAttention" || error !== null) && needsPreparation ? <><p role="alert">couldn’t prepare text</p><Button disabled={blocking} onClick={() => navigation && void run({ kind: "prepare", body: { id: crypto.randomUUID(), expected_source_generation: navigation.generation } })}>try again</Button></> : null}
        {freshChoice ? <p>the sections changed. choose from the current contents</p> : null}
        {navigation && (definition !== null || freshChoice) ? <SelectField layout="Stacked" label="first section" value={freshChoice ? "" : first ?? ""} disabled={blocking} onChange={event => chooseFirst(event.target.value)}>
          {freshChoice ? <option value="" disabled>choose a section</option> : null}
          {navigation.sections.map(section => <option key={section.section_id} value={section.section_id} disabled={!eligible(section.section_id)}>{section.label}</option>)}
        </SelectField> : start ? <p>{start.label}</p> : null}
        {definition === null ? <details open={adjacent} onToggle={event => setAdjacent(event.currentTarget.open)}><summary>include adjacent sections</summary>
          <SelectField layout="Stacked" label="last section" value={last ?? ""} disabled={blocking} onChange={event => state.set(value => ({ ...value, last: event.target.value }))}>
            {ends.map(section => <option key={section.section_id} value={section.section_id}>{section.label}</option>)}
          </SelectField>
        </details> : <><SelectField layout="Stacked" label="last section" value={last ?? ""} disabled={blocking} onChange={event => state.set(value => ({ ...value, last: event.target.value }))}>
          {ends.map(section => <option key={section.section_id} value={section.section_id}>{section.label}</option>)}
        </SelectField><p>changing these sections also changes this work’s shared links.</p></>}
        {selector ? <PartPreview preview={preview} /> : null}
        {blockedPreview ? <p role="alert">{partBlockMessage(previewConflict?.reason ?? null)}</p> : null}
      </> : null}
      {error ? <p role="alert">{error}</p> : null}
      {conflict && definition ? <section aria-label="current saved work"><p>currently saved: {definition.title}</p>
        <p>{savedLabels !== null && savedLabels.length > 0 && savedLabels.every(label => label !== null) ? savedLabels.join(" through ") : "saved range"}</p>
        <Button disabled={blocking || readFailure || readPending || canBounds && (selector === null || preview.status !== "ready" || preview.error !== null || blockedPreview)} onClick={() => state.set(value => ({ ...value, version: definition.version, baselineSelection: definition.selection, conflict: false, error: null }))}>keep my changes</Button>
      </section> : null}
      {request !== null && !busy ? <Button onClick={() => void run(request, true)}>try same request again</Button> : null}
      <Button emphasis="strong" disabled={blocking || conflict || title.trim() === "" || canBounds && (selector === null || preview.status !== "ready" || preview.error !== null || blockedPreview)} aria-busy={busy} onClick={save}>{definition === null ? "extract" : "save"}</Button>
    </div>
  </Dialog>;
}
