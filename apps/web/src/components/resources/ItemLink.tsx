"use client";

import {useEffect, useRef, useState} from "react";
import {Ruling} from "@/components/feedback/Ruling";
import {usePaneFreeServerValue} from "@/lib/api/serverState";
import {resolveResourceItem} from "@/lib/resources/items";
import {Fact, Failed} from "@/components/feedback/Fact";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import {apiFetch, isApiError, isSameSystemApiDefect} from "@/lib/api/client";
import type {ApiJson} from "@/lib/api/wire";
import {dailyPage} from "@/lib/notes/api";
import {useWritingRuntime} from "@/lib/notes/hooks";
import {isAuthoredStorageFailure, LocalCommitError} from "@/lib/notes/runtime";
import {createLink, LinkInputRefusal, prepareTarget, type ItemLinkSource} from "@/lib/resourceGraph/links";
import {pickedTarget, useReferenceQuery} from "@/lib/resourceGraph/useReferenceInput";
import type {LinkTargetResult} from "@/lib/resourceGraph/useLinkTargets";
import type {ReturnFocusTarget} from "@/lib/ui/overlay";
import type {SearchActive} from "@/lib/ui/searchOptions";
import ReferencePicker from "./ReferencePicker";

async function sourceTarget(source: ItemLinkSource, signal?: AbortSignal) {
  if (source.target) return source.target;
  const frozen = source.passage;
  if (!frozen?.revision) throw new LinkInputRefusal();
  const {data} = await apiFetch<ApiJson<"/resource-items/targets/search", "post">>("/api/resource-items/targets/search", {
    method: "POST", signal, body: JSON.stringify({q: source.ref, reading_media_id: frozen.readingMediaId,
      source_ref: null, exclude_refs: [], cursor: null}),
  });
  const [target] = data.targets;
  if (data.targets.length !== 1 || target?.kind !== "passage" || target.candidate_ref !== source.ref ||
      target.item.preview.body.kind !== "passage" || target.item.preview.body.link_revision !== frozen.revision) {
    throw new LinkInputRefusal();
  }
  return pickedTarget(target);
}

/** A fixed source owns no editor position. The note picker supplies the chosen
 * endpoint; the account owns the accepted change through durable local commit. */
export default function ItemLink({source, open, onClose, returnFocusTo, returnFocusFallback}: {
  source: ItemLinkSource; open: boolean; onClose(): void;
  returnFocusTo: ReturnFocusTarget; returnFocusFallback: ReturnFocusTarget;
}) {
  const writing = useWritingRuntime();
  const passage = source.passage !== undefined || source.target?.kind === "passage";
  const needsIdentity = passage || source.journalDate !== undefined;
  const identity = usePaneFreeServerValue({key: needsIdentity ? `link-source:${source.ref}:${source.passage?.revision ?? ""}` : null,
    stale: "", load: async signal => {
      try {
        if (source.journalDate) {
          const day = await dailyPage(writing, source.journalDate);
          return {kind: "ready" as const, ref: day.ref, remote: day.prelude.length ? null : day.ref};
        }
        const endpoint = await prepareTarget(writing, await sourceTarget(source, signal));
        // A fresh local anchor is a valid endpoint before the server has seen
        // it. Only a known remote anchor can scope a server target query.
        const known = await resolveResourceItem(endpoint.ref, signal);
        return {kind: "ready" as const, ref: endpoint.ref, remote: known.missing ? null : endpoint.ref};
      } catch (error) {
        if (error instanceof LinkInputRefusal || isAuthoredStorageFailure(error)) return {kind: "refused" as const, error};
        throw error;
      }
    }});
  const resolved = needsIdentity ? identity.status === "ready" && identity.data.kind === "ready" ? identity.data : null
    : {ref: source.ref, remote: source.ref};
  const field = useRef<HTMLInputElement>(null);
  const [raw, setRaw] = useState("");
  const [active, setActive] = useState<SearchActive>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [failure, setFailure] = useState<{error: unknown; selected: LinkTargetResult} | null>(null);
  const frozen = failure?.error instanceof LocalCommitError ? failure.error : null;
  useEffect(() => {
    if (!frozen) return;
    let current = true;
    void frozen.completion.then(() => {if (current) onClose();}, error => {
      if (current) setFailure(previous => previous && {...previous, error});
    });
    return () => {current = false;};
  }, [frozen, onClose]);
  async function accept(selected: LinkTargetResult) {
    if (running.current || !open) return;
    running.current = true;
    setBusy(true);
    try {
      if (frozen) {
        await frozen.retry();
      } else {
        const day = source.journalDate ? await dailyPage(writing, source.journalDate) : null;
        const from = await prepareTarget(writing, day ? {kind: "resource", ref: day.ref} : await sourceTarget(source));
        const to = await prepareTarget(writing, pickedTarget(selected));
        if (from.ref !== resolved?.ref || from.ref === to.ref) throw new LinkInputRefusal();
        await createLink(writing, {source_ref: from.ref, source_label: source.label, target_ref: to.ref, target_label: selected.item.label,
          after: null, prelude: [...day?.prelude ?? [], ...from.intents, ...to.intents]});
      }
      onClose();
    } catch (error) {
      setFailure({error: frozen ?? error, selected});
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const query = useReferenceQuery({raw: "@"+raw, source: resolved?.ref ?? null, remoteSource: resolved?.remote ?? null,
    excludeRef: source.ref, label: source.label, enabled: open && resolved !== null, open, context: raw, active, setActive,
    disabled: frozen || busy ? "saving this link." : null, choose: selected => {void accept(selected);}});
  const error = failure?.error;
  const retry = () => {if (failure) void accept(failure.selected);};
  if (failure && !(error instanceof LinkInputRefusal || frozen || isAuthoredStorageFailure(error) ||
    isApiError(error) && !isSameSystemApiDefect(error))) throw error;
  return <Dialog open={open} title="link to…" onClose={onClose} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback}
    onDismissRequest={() => running.current ? "blocked" : "accepted"} initialFocus={() => field.current}>
    <Input ref={field} {...query.bindings.inputProps} aria-label={`link from ${source.label}`} placeholder="search" value={raw}
      readOnly={busy || frozen !== null} onChange={event => {setRaw(event.target.value); setFailure(null);}}
      onKeyDown={event => {if (query.bindings.handleKey(event.nativeEvent, event.nativeEvent.isComposing)) event.preventDefault();}} />
    {resolved ? <ReferencePicker input={query} returnFocus={() => field.current} />
      : identity.status === "loading" ? <Ruling />
      : identity.status === "failed" ? <Failed error={identity.error} noun="this passage" retry={{run: identity.refetch, busy: identity.retrying}} />
      : identity.data.kind === "refused" && identity.data.error instanceof LinkInputRefusal ? <Fact line={identity.data.error.line} speak />
      : <Fact line={{fact: "couldn’t open this passage on this device."}} verbs={[{label: "retry", commandKey: "RetryLinkSource", run: identity.refetch}]} />}
    {error instanceof LinkInputRefusal ? <Fact line={error.line} speak />
      : frozen || isAuthoredStorageFailure(error) ? <Fact line={{fact: "couldn’t save this link on this device."}} speak
        verbs={[{label: "retry", commandKey: "RetryItemLink", run: retry, busy}]} />
      : isApiError(error) ? <Failed error={error} noun="this passage" retry={{run: retry, busy}} /> : null}
  </Dialog>;
}
