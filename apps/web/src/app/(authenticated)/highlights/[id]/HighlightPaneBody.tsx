"use client";

/** The capture and its writing survive independently of source availability. */
import {useEffect, useMemo, useRef, useState} from "react";
import ReaderExcerpt from "@/components/resources/ReaderExcerpt";
import type {ExcerptView} from "@nexus/authored/excerpt";
import {normalizeQuote} from "@nexus/authored/identity";
import {bodyPassageRange} from "@/lib/notes/inspection";
import {matchScopeQuote, normalizeScopeText} from "@nexus/authored/scope";
import Button from "@/components/ui/Button";
import HighlightAnnotation from "@/components/notes/HighlightAnnotation";
import type {NoteInspection} from "@/components/notes/NoteEditor";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import {useResourceInspector} from "@/components/resource-inspector/useResourceInspector";
import {useAuthoredQuery} from "@/lib/notes/hooks";
import {usePaneChrome} from "@/lib/panes/paneChrome";
import {usePaneEntryDelivery, usePaneParam} from "@/lib/panes/paneRuntime";
import {useSourceArrival, type SourceArrivalContext} from "@/lib/reader/sourceArrival";
import {highlightSourceHref} from "@/lib/resources/localResource";
import {canonicalResourceRef} from "@/lib/sharing/targets";
import {usePaneReturnReady} from "@/lib/workspace/paneReturnMemento";

export default function HighlightPaneBody() {
  const id = usePaneParam("id");
  if (!id) throw new Error("highlight route requires an id");
  const ref = `highlight:${id}`;
  const read = useAuthoredQuery({kind: "excerpt", ref, reading_ref: null});
  const resource = read.data?.rows[0]?.resource;
  const capture = useRef<ExcerptView | null>(null);
  if (resource?.excerpt) capture.current = resource.excerpt;
  const [unresolved, setUnresolved] = useState<string | null>(null);
  const [inspection, setInspection] = useState<NoteInspection | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const pending = useRef<SourceArrivalContext | null>(null);
  const {delivery, claim} = usePaneEntryDelivery();
  useEffect(() => {if (resource && delivery?.entry.kind === "EditHighlightAnnotation" && delivery.entry.highlightId === id && claim(delivery)) {pending.current = null; setFocus(value => (value ?? 0) + 1);}}, [resource, delivery, claim, id]);
  const arrival = useSourceArrival({ready: resource !== undefined, sourceIdentity: resource?.body_text ?? "", apply: async (target, context) => {
    if (!resource || context.signal.aborted) return "Unavailable";
    let range: {startOffset: number; endOffset: number} | null = null;
    let annotation = true;
    const text = resource.body_text ?? "";
    if (target.kind === "passage") {
      if (target.passage.source_ref !== ref) return "Unavailable";
      const normalized = normalizeScopeText(text);
      const match = matchScopeQuote([{fragment_id: id, start_offset: 0, normalized_text: normalized.normalized_text, normalized_start_offset: 0, edits: normalized.edits, start_cut: false, end_cut: false}], target.passage.normalized_exact, target.passage.prefix, target.passage.suffix);
      if (!match) return "Unavailable";
      range = bodyPassageRange(text, match.start_offset, match.end_offset, target.passage.normalized_exact);
      if (!range) return "Unavailable";
    } else if (target.kind === "source") {
      const location = target.source.location;
      const field = target.source.source_activation?.field;
      if (field === undefined) return "Unavailable";
      annotation = field === "annotation";
      if (!annotation && location.kind !== "resource") return "Unavailable";
      if (location.kind === "located") {
        const locator = location.locator;
        if (locator.type !== "highlight_annotation_offsets" || locator.highlight_id !== id) return "Unavailable";
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
        if (locator.body_sha256 === digest) {
          const points = Array.from(text);
          if (!Number.isInteger(locator.start_offset) || !Number.isInteger(locator.end_offset) || locator.start_offset < 0 || locator.end_offset <= locator.start_offset || locator.end_offset > points.length || points.slice(locator.start_offset, locator.end_offset).join("") !== locator.text_quote_selector.exact) {
            setUnresolved(locator.text_quote_selector.exact);
            return "Unavailable";
          }
          range = {startOffset: locator.start_offset, endOffset: locator.end_offset};
        }
        else {
          const selector = locator.text_quote_selector, normalized = normalizeScopeText(text);
          const match = matchScopeQuote([{fragment_id: id, start_offset: 0, normalized_text: normalized.normalized_text, normalized_start_offset: 0, edits: normalized.edits, start_cut: false, end_cut: false}], normalizeQuote(selector.exact), normalizeQuote(selector.prefix ?? ""), normalizeQuote(selector.suffix ?? ""));
          range = match ? bodyPassageRange(text, match.start_offset, match.end_offset, normalizeQuote(selector.exact)) : null;
          if (!range) {setUnresolved(selector.exact); return "Unavailable";}

        }
      } else if (location.kind !== "resource") return "Unavailable";
    } else {
      if (target.kind !== "resource" || target.resource_ref !== ref) return "Unavailable";
      annotation = target.field === "annotation";
    }
    setUnresolved(null);
    setInspection(range ? {text, ...range, activationId: context.activationId, signal: context.signal, mayFocus: context.mayFocus, restored: context.restored} : null);
    if (!annotation) {pending.current = null; return "Applied";}
    pending.current = context;
    setFocus(value => (value ?? 0) + 1);
    return "Applied";
  }});
  usePaneReturnReady(read.data !== null || read.error !== null);
  const connections = useMemo(() => <ConnectionsSurface resourceRef={{scheme: "highlight", id}}/>, [id]);
  useResourceInspector({scheme: "highlight", handle: resource ? id : null, bodies: {linkedItems: connections}});
  const resourceRef = resource ? canonicalResourceRef({scheme: "highlight", id}) : undefined;
  usePaneChrome(useMemo(() => ({resourceRef}), [resourceRef]));
  const source = resource ? highlightSourceHref(resource) : null;
  return <article>
    {capture.current ? <ReaderExcerpt excerpt={capture.current} color={resource?.color ?? null} full /> : null}
    {!resource ? <p>{read.data ? "this highlight is no longer available." : "opening highlight…"}</p> : null}
    {read.error ? <div role="alert">couldn’t open this highlight on this device. <Button onClick={read.retry}>retry</Button></div> : null}
    {source ? <a href={source} data-workspace-rich-target="true">view in source</a> : null}
    {unresolved ? <blockquote aria-label="captured annotation passage">{unresolved}</blockquote> : null}
    {arrival.failure ? <p role="status">{arrival.failure.title}</p> : null}
    <HighlightAnnotation highlightRef={ref} occurrenceKey={`detail:${ref}`} focusRequest={focus} inspection={inspection} onFocused={() => {pending.current = null;}} mayFocus={() => pending.current?.mayFocus() ?? true}/>
    {connections}
  </article>;
}
