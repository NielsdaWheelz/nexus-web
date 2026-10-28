"use client";

// Reference intent is visit-owned draft state above prose persistence. Acceptance
// freezes identity and placement; only the queue head seals its causal version.
import { useEffect, useId, useRef } from "react";
import { reconcileSearchActive, useSearchOptions, type SearchActive } from "@/lib/ui/searchOptions";
import type { NoteBody } from "@nexus/authored/body";
import type { TextEditBase } from "@/lib/notes/editorTypes";

import type { ResourceItem } from "@/lib/resources/items";
import {
  type LinkTarget,
} from "./links";
import {
  targetKey,
  useLinkTargets,
  type LinkTargetResult,
} from "./useLinkTargets";
import { useEditorDraft } from "@/lib/notes/editorHost";

export interface ReferenceInputHost {
  source_ref: string | null;
  onSelected(target: LinkTarget, item: ResourceItem): void;
  label: string;
  onActiveChange?(active: boolean): void;
}
type ReferenceContext = { source_ref: string | null };
function referenceContext(host: ReferenceInputHost): ReferenceContext { return { source_ref: host.source_ref }; }
type State = {
  row_id: string | null;
  context: ReferenceContext;
  message: string | null;
  raw: string;
  base: NoteBody;
  editBase: TextEditBase | null;
  host: ReferenceInputHost;
  active: SearchActive;
};

export function useReferenceInput(
  editorKey: string,
  host: ReferenceInputHost | null,
  pickerOpen: boolean,
  input: {
    row_id: string | null;
    prepareAccept(): boolean;
    accepted(row_id: string | null, base: NoteBody): void;
  },
) {
  const row_id = input.row_id;
  const paneActive = pickerOpen;
  const draft = useEditorDraft<State | null>(
    `Resources.ReferenceDraft:${editorKey}`,
    () => null,
  );
  const state = draft.value;
  const listId = `reference-${useId().replaceAll(":", "")}`;
  const active = state !== null;
  const paused = false;
  const hasHost = host !== null;
  const set = draft.set;
  const sourceRef = state?.host.source_ref ?? null;
  const search = useLinkTargets(
    state?.raw ?? "",
    sourceRef,
    state !== null,
    paneActive && pickerOpen,
    sourceRef,
  );
  const context = JSON.stringify([draft.owner, state?.context, state?.raw]);
  const admitted = pickerOpen && state !== null && state.row_id === row_id && !paused && search.querySettled && !search.minimum && search.current;
  const options = admitted ? search.items.map(item => ({ key: targetKey(item), disabledReason: state.message })) : [];
  const reconciled = reconcileSearchActive({ context, admitted, options,
    firstExistingKey: options[0]?.key ?? null, active: state?.active ?? null });
  const selected = admitted ? reconciled?.key ?? null : null;
  useEffect(() => {
    const value = draft.read();
    if (value && value === state && value.active !== reconciled) set({ ...value, active: reconciled });
    // Selection belongs to the reference draft; reconciliation changes no text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, reconciled]);
  const bindings = useSearchOptions({ listId, label: `link from ${state?.host.label ?? "editor"}`,
    open: pickerOpen && state !== null && state.row_id === row_id, options, activeKey: selected,
    onActiveChange(key) {
      const value = draft.read();
      if (value && value === state) set({ ...value, active: { context, key } });
    },
    onActivate(key) { accept(search.items.find(item => targetKey(item) === key)); },
  });
  const activeHost = useRef(host);
  activeHost.current = host;
  useEffect(() => {
    const report = activeHost.current?.onActiveChange;
    report?.(active);
    return () => report?.(false);
  }, [active, draft.owner, hasHost]);
  function accept(target: LinkTargetResult | undefined) {
    if (!input.prepareAccept()) return;
    const value = draft.read();
    if (
      !value ||
      value.row_id !== row_id ||
      !admitted ||
      value.message !== null ||
      value.raw !== state?.raw ||
      !target ||
      !search.items.includes(target)
    )
      return;
    if (host === null) return;
    const current = referenceContext(host);
    const frozen = value.context;
    if (JSON.stringify(current) !== JSON.stringify(frozen)) {
      set({ ...value, message: "the outline changed. your query is kept; review its destination before linking." });
      return;
    }
    const owner = host;
    const selectedTarget =
      target.kind === "resource"
        ? { kind: "resource" as const, ref: target.item.ref }
        : { kind: "passage" as const, candidate_ref: target.candidate_ref, passage_target: target.target };
    set(null);
    input.accepted(value.row_id, value.base);
    owner.onSelected(selectedTarget, target.item);
  }

  return {
    state,
    owner: draft.owner,
    search: { ...search, items: admitted ? search.items : [] },
    selected,
    bindings,
    acceptSelected() { if (selected !== null) accept(search.items.find(item => targetKey(item) === selected)); },
    isReady: () => true,
    reviewPosition() {
      const value = draft.read();
      const context = host ? referenceContext(host) : null;
      if (value && context && host) {
        set({ ...value, row_id, context, host, message: null });
      }
    },
    getState: draft.read,
    begin(base: NoteBody, field_id: string | null = row_id, suppliedHost: ReferenceInputHost | null = host) {
      const context = suppliedHost ? referenceContext(suppliedHost) : null;
      if (suppliedHost && context && draft.read() === null) {
        set({ row_id: field_id, context, message: null, raw: "@", base, editBase: null, host: { ...suppliedHost },
          active: null,
        });
      }
    },
    edit(raw: string) {
      const value = draft.read();
      if (value) set({ ...value, raw });
    },
    literal() {
      if (draft.read() === null) return false;
      set(null);
      return true;
    },
  };
}
export type ReferenceInput = ReturnType<typeof useReferenceInput>;
