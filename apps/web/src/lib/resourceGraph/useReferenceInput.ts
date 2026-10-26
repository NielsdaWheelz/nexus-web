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
) {
  const paneActive = pickerOpen;
  const draft = useEditorDraft<{ state: State | null; completion: number }>(
    `Resources.ReferenceDraft:${editorKey}`,
    () => ({ state: null, completion: 0 }),
  );
  const { state, completion } = draft.value;
  const listId = `reference-${useId().replaceAll(":", "")}`;
  const active = state !== null;
  const paused = false;
  const hasHost = host !== null;
  function set(next: State | null, completed = false) {
    draft.set(previous => ({ state: next, completion: previous.completion + (completed ? 1 : 0) }));
  }
  const sourceRef = state?.host.source_ref ?? null;
  const search = useLinkTargets(
    state?.raw ?? "",
    sourceRef,
    state !== null,
    paneActive && pickerOpen,
    sourceRef,
  );
  const context = JSON.stringify([draft.owner, state?.context, state?.raw]);
  const admitted = pickerOpen && state !== null && !paused && search.querySettled && !search.minimum && search.current;
  const options = admitted ? search.items.map(item => ({ key: targetKey(item), disabledReason: state.message })) : [];
  const reconciled = reconcileSearchActive({ context, admitted, options,
    firstExistingKey: options[0]?.key ?? null, active: state?.active ?? null });
  const selected = admitted ? reconciled?.key ?? null : null;
  useEffect(() => {
    const value = draft.read().state;
    if (value && value === state && value.active !== reconciled) set({ ...value, active: reconciled });
    // Selection belongs to the reference draft; reconciliation changes no text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, reconciled]);
  const bindings = useSearchOptions({ listId, label: `link from ${state?.host.label ?? "editor"}`,
    open: pickerOpen && state !== null, options, activeKey: selected,
    onActiveChange(key) {
      const value = draft.read().state;
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
    const value = draft.read().state;
    if (
      !value ||
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
    owner.onSelected(selectedTarget, target.item);
    set(null, true);
  }

  return {
    state,
    owner: draft.owner,
    completion,
    search: { ...search, items: admitted ? search.items : [] },
    selected,
    bindings,
    acceptSelected() { if (selected !== null) accept(search.items.find(item => targetKey(item) === selected)); },
    isReady: () => true,
    reviewPosition() {
      const value = draft.read().state;
      const context = host ? referenceContext(host) : null;
      if (value && context && host) {
        set({ ...value, context, host, message: null });
      }
    },
    getState: () => draft.read().state,
    begin(base: NoteBody) {
      const context = host ? referenceContext(host) : null;
      if (host && context && draft.read().state === null) {
        set({ context, message: null, raw: "@", base, editBase: null, host: { ...host },
          active: null,
        });
      }
    },
    edit(raw: string) {
      const value = draft.read().state;
      if (value) set({ ...value, raw });
    },
    literal() {
      if (draft.read().state === null) return false;
      set(null);
      return true;
    },
  };
}
export type ReferenceInput = ReturnType<typeof useReferenceInput>;
