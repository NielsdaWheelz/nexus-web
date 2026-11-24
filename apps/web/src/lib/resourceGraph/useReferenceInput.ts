"use client";

// Reference intent is visit-owned draft state above prose persistence. Acceptance
// freezes identity and placement; only the queue head seals its causal version.
import { useEffect, useId, useRef } from "react";
import { reconcileSearchActive, useSearchOptions, type SearchActive } from "@/lib/ui/searchOptions";
import { captureLocator } from "@nexus/authored/capture";
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

export type ReferenceInputHost = {
  source_ref: string | null;
  label: string;
  onActiveChange?(active: boolean): void;
} & (
  /** An insertion lands the reference beside the field, at once. Where the field's own occurrence can take the
   * reference in its place, `consume` answers instead and settles as a replacement does; null means insert. */
  | {replacement: null; onSelected(target: LinkTarget, item: ResourceItem): void; consume?(target: LinkTarget, item: ResourceItem): Promise<boolean> | null}
  /** A replacement resolves true once it has settled the acceptance. False: it refused aloud, and the query stands. */
  | {replacement: {occurrence_key: string; link_id: string}; onSelected(target: LinkTarget, item: ResourceItem): Promise<boolean>}
);
type ReferenceContext = Pick<ReferenceInputHost, "source_ref" | "replacement">;
function referenceContext(host: ReferenceInputHost): ReferenceContext { return { source_ref: host.source_ref, replacement: host.replacement }; }
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

/** Both the inline @ field and the menu choose from this exact settled collection. */
export function pickedTarget(target: LinkTargetResult): LinkTarget {
  if (target.kind === "resource") return {kind: "resource", ref: target.item.ref};
  return {kind: "passage", candidate_ref: target.candidate_ref, passage_target: target.target,
    capture: {...target.capture, locator: target.capture.locator === null ? null : captureLocator(target.capture.locator, target.target.owner_ref)}};
}
export function useReferenceQuery(input: {
  raw: string; source: string | null; excludeRef?: string; label: string; enabled: boolean; open: boolean;
  context: string; active: SearchActive; disabled: string | null;
  setActive(value: SearchActive): void; choose(target: LinkTargetResult): void;
}) {
  const listId = `reference-${useId().replaceAll(":", "")}`;
  const search = useLinkTargets(input.raw, input.source, input.enabled, input.open, input.excludeRef);
  const admitted = input.open && search.querySettled && !search.minimum && search.current;
  const items = admitted ? search.items : [];
  const options = items.map(item => ({key: targetKey(item), disabledReason: input.disabled}));
  const reconciled = reconcileSearchActive({context: input.context, admitted, options,
    initialKey: options[0]?.key ?? null, active: input.active});
  const selected = admitted ? reconciled?.key ?? null : null;
  useEffect(() => {
    if (input.active !== reconciled) input.setActive(reconciled);
  }, [input, reconciled]);
  const accept = (key: string) => {
    const target = items.find(item => targetKey(item) === key);
    if (target && input.disabled === null) input.choose(target);
  };
  const bindings = useSearchOptions({listId, label: `link from ${input.label}`, open: input.open, options,
    activeKey: selected, onActiveChange: key => input.setActive({context: input.context, key}), onActivate: accept});
  return {search: {...search, items}, bindings, selected, acceptSelected() { if (selected !== null) accept(selected); }};
}

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
  const draft = useEditorDraft<State | null>(
    `Resources.ReferenceDraft:${editorKey}`,
    () => null,
  );
  const state = draft.value;
  const accepting = useRef<State | null>(null);
  const active = state !== null;
  const hasHost = host !== null;
  const set = draft.set;
  const query = useReferenceQuery({
    raw: state?.raw ?? "", source: state?.host.source_ref ?? null, label: state?.host.label ?? "editor",
    enabled: active, open: pickerOpen && active && state.row_id === row_id,
    context: JSON.stringify([draft.owner, state?.context, state?.raw]), active: state?.active ?? null,
    disabled: state?.message ?? null,
    setActive(next) {
      const value = draft.read();
      if (value && value === state && value.active !== next) set({ ...value, active: next });
    },
    choose: accept,
  });
  const activeHost = useRef(host);
  activeHost.current = host;
  useEffect(() => {
    const report = activeHost.current?.onActiveChange;
    report?.(active);
    return () => report?.(false);
  }, [active, draft.owner, hasHost]);
  function accept(target: LinkTargetResult | undefined) {
    if (accepting.current !== null) return;
    if (!input.prepareAccept()) return;
    const value = draft.read();
    if (
      !value ||
      value.row_id !== row_id ||
      value.message !== null ||
      value.raw !== state?.raw ||
      !target ||
      !query.search.items.includes(target)
    )
      return;
    if (host === null) return;
    const current = referenceContext(host);
    const frozen = value.context;
    if (JSON.stringify(current) !== JSON.stringify(frozen)) {
      set({ ...value, message: "the link destination changed." });
      return;
    }
    const selectedTarget = pickedTarget(target);
    const owner = value.host;
    const settling = owner.replacement !== null ? owner.onSelected(selectedTarget, target.item)
      : host.replacement === null ? host.consume?.(selectedTarget, target.item) ?? null : null;
    if (settling !== null) {
      accepting.current = value;
      // The occurrence owns admission. A refusal keeps the exact query and native
      // selection; preparation never queues another acceptance. A settled acceptance
      // closes its own draft whatever was typed since: its field is no longer the query's.
      void settling.then(accepted => {
        if (!accepted || draft.read()?.host !== value.host) return;
        set(null);
        input.accepted(value.row_id, value.base);
      }).finally(() => {if (accepting.current === value) accepting.current = null;});
      return;
    }
    set(null);
    input.accepted(value.row_id, value.base);
    host.onSelected(selectedTarget, target.item);
  }

  return {
    state,
    owner: draft.owner,
    ...query,
    reviewPosition() {
      const value = draft.read();
      const context = host ? referenceContext(host) : null;
      if (value && value.context.replacement === null && context && host) {
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
      if (value) set({ ...value, raw: value.context.replacement !== null && !raw.startsWith("@") ? `@${raw}` : raw });
    },
    close() {
      if (draft.read() === null) return false;
      set(null);
      return true;
    },
  };
}
export type ReferenceInput = ReturnType<typeof useReferenceInput>;
