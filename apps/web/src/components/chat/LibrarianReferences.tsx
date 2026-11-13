"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type MouseEvent, type RefObject } from "react";
import Button from "@/components/ui/Button";
import RadioGroup from "@/components/ui/RadioGroup";
import { MarkdownPreview, TextPreview } from "@/components/ui/MarkdownMessage";
import { useCompanionPresentation } from "@/components/workspace/companionPresentation";
import type { Schema } from "@/lib/api/wire";
import type { Message, Turn } from "@/lib/chat/wire";
import { useMarginLayout, type MarginSource, type MarginMeasurement } from "@/lib/margin/useMarginLayout";
import { usePaneCompanion } from "@/lib/panes/paneChrome";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { getOverlayOpeners } from "@/lib/ui/overlay";
import { definePaneVisitDataKey, usePaneVisitData, usePaneVisitDataWriter } from "@/lib/workspace/paneReturnMemento";
import ReferenceFigure from "./ReferenceFigure";
import type { ChatScrollHandle } from "./useChatScroll";
import styles from "./ChatSurface.module.css";

type ReferenceOccurrence = {
  key: string;
  message: Message;
  value: Schema<"AttachmentOut"> | Schema<"ChatCitationOut">;
};
type ReferenceControl = { kind: "named"; id: string } | { kind: "link"; href: string };
type Memory = {
  queryKey: string;
  mode: "margin" | "all";
  anchor: { occurrenceKey: string; offsetPx: number } | null;
  focus: { occurrenceKey: string; control: ReferenceControl | null } | null;
};
type RevealRequest = { key: string; keyboard: boolean; control: ReferenceControl | null; reveal: boolean };
const REFERENCES = definePaneVisitDataKey<Memory>("Librarian.References");

const rowFor = (key: string, root: HTMLElement | null) => root?.querySelector<HTMLElement>(`[data-reference-key="${CSS.escape(key)}"]`) ?? null;
const keyOf = (element: Element): string | null => {
    const row = element.closest<HTMLElement>("[data-reference-key]");
    if (row) return row.dataset.referenceKey ?? null;
    const marker = element.closest<HTMLElement>("[data-citation-id]");
    const message = marker?.closest<HTMLElement>("[data-message-id]");
    return marker && message ? `${message.dataset.messageId}:citation:${marker.dataset.citationId}` : null;
  };

/** One publication from the accepted transcript. The shell owns its host; this
 * owner keeps only session presentation and occurrence identity across hosts. */
export function useLibrarianReferences(input: {
  scope: string; queryKey: string; turns: readonly Turn[]; ready: boolean;
  port: RefObject<HTMLDivElement | null>; transcript: RefObject<HTMLDivElement | null>; scroll: ChatScrollHandle;
}) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "librarian references");
  const presentation = useCompanionPresentation();
  const column = presentation === "Column";
  const open = runtime.secondaryPane?.group_id === "librarian-inspector" && runtime.secondaryPane.visibility === "visible";
  // An occurrence belongs to a message; repeated markers share their published
  // retrieval identity, never a source-wide card.
  const occurrences = useMemo<ReferenceOccurrence[]>(() => input.turns.flatMap(turn => [
    ...turn.user_message.attachments.map((value, index) => ({
      key: `${turn.user_message.id}:attachment:${index}`, message: turn.user_message, value,
    })),
    ...turn.assistant_message.citations.map(value => ({
      key: `${turn.assistant_message.id}:citation:${value.id}`, message: turn.assistant_message, value,
    })),
  ]), [input.turns]);
  const current = useRef(input); current.current = input;
  const values = useRef(occurrences); values.current = occurrences;
  const pane = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const memory = useRef<Memory>({ queryKey: input.queryKey, mode: "margin", anchor: null, focus: null });
  const retained = usePaneVisitData(REFERENCES, () => memory.current);
  const save = usePaneVisitDataWriter(REFERENCES);
  const [mode, setMode] = useState<Memory["mode"]>(() => retained?.queryKey === input.queryKey ? retained.mode : "margin");
  const [request, setRequest] = useState<RevealRequest | null>(null);
  const restore = useRef(retained?.queryKey === input.queryKey ? retained : null);
  memory.current = { ...memory.current, mode };
  const active = useRef<string | null>(null);
  const demanded = useRef<{ messageId: string; scrollTop: number | null } | null>(null);
  const paint = useCallback((key: string | null) => {
    active.current = key;
    for (const root of [current.current.transcript.current, pane.current]) {
      for (const element of root?.querySelectorAll<HTMLElement>("[data-reference-key], [data-citation-id]") ?? [])
        element.toggleAttribute("data-reference-corresponding", key !== null && keyOf(element) === key);
    }
  }, []);
  const focusOccurrence = useCallback((key: string, control: ReferenceControl | null) => {
    const roots = [pane.current, current.current.transcript.current];
    const row = roots.map(root => rowFor(key, root)).find(node => node && !node.closest("[hidden], [inert]") && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
    if (!row) return false;
    const exact = control === null ? null : control.kind === "named"
      ? row.querySelector<HTMLElement>(`[data-reference-control="${CSS.escape(control.id)}"]`)
      : row.querySelector<HTMLElement>(`a[href="${CSS.escape(control.href)}"]`);
    const target = exact ?? row.querySelector<HTMLElement>("a[href], button") ?? row.querySelector<HTMLElement>("figure") ?? row;
    target.focus({ preventScroll: true });
    return true;
  }, []);
  const rememberList = useCallback(() => {
    const port = list.current;
    if (!port || column && mode === "margin") return;
    const top = port.getBoundingClientRect().top;
    const row = [...port.querySelectorAll<HTMLElement>("[data-reference-key]")].find(node => node.getBoundingClientRect().bottom > top);
    memory.current = { ...memory.current, anchor: row ? { occurrenceKey: row.dataset.referenceKey!, offsetPx: row.getBoundingClientRect().top - top } : null };
    save(memory.current);
  }, [column, mode, save]);
  const onFocusCapture = useCallback((event: FocusEvent<HTMLElement>) => {
    const key = keyOf(event.target);
    paint(key);
    if (!key || !event.target.matches(":focus-visible")) { memory.current = { ...memory.current, focus: null }; save(memory.current); return; }
    current.current.scroll.releaseFollowing();
    const named = event.target.closest<HTMLElement>("[data-reference-control]")?.dataset.referenceControl;
    const href = event.target.closest<HTMLAnchorElement>("a[href]")?.getAttribute("href");
    memory.current = { ...memory.current, focus: { occurrenceKey: key, control: named ? { kind: "named", id: named } : href ? { kind: "link", href } : null } };
    save(memory.current);
  }, [paint, save]);
  const onPointerDownCapture = useCallback(() => {
    memory.current = { ...memory.current, focus: null }; save(memory.current);
  }, [save]);
  const interactions = useMemo(() => ({ onFocusCapture, onPointerDownCapture,
    onMouseOver: (event: MouseEvent<HTMLElement>) => { if (event.target instanceof Element) paint(keyOf(event.target)); },
    onMouseLeave: () => paint(document.activeElement instanceof Element ? keyOf(document.activeElement) : null),
  }), [onFocusCapture, onPointerDownCapture, paint]);
  const source = useMemo<MarginSource>(() => ({
    subscribeGeometry: input.scroll.subscribeGeometry,
    measure(held) {
      const port = current.current.port.current, transcript = current.current.transcript.current;
      if (!port || !transcript || !current.current.ready) return null;
      const viewport = port.getBoundingClientRect();
      if (demanded.current?.scrollTop === null) demanded.current.scrollTop = port.scrollTop;
      if (demanded.current && demanded.current.scrollTop !== port.scrollTop) demanded.current = null;
      const anchors = values.current.flatMap<MarginMeasurement["anchors"][number]>(occurrence => {
        const message = transcript.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(occurrence.message.id)}"]`);
        const target = "target" in occurrence.value ? message?.querySelector<HTMLElement>(`[data-citation-id="${CSS.escape(occurrence.value.id)}"]`)
          : message?.querySelector<HTMLElement>("[data-message-content]");
        if (!target) {
          if (message && "target" in occurrence.value) throw new Error("published citation has no rendered marker");
          return held.has(occurrence.key) ? [{ key: occurrence.key, line: null }] : [];
        }
        const range = document.createRange(); range.selectNodeContents(target);
        const rect = range.getClientRects()[0] ?? target.getBoundingClientRect();
        return held.has(occurrence.key) || demanded.current?.messageId === occurrence.message.id || rect.bottom >= viewport.top - viewport.height && rect.top <= viewport.bottom + viewport.height
          ? [{ key: occurrence.key, line: { top: rect.top, height: rect.height } }] : [];
      });
      return { sourceIdentity: current.current.scope, positionKey: String(port.scrollTop), viewport: { top: viewport.top, bottom: viewport.bottom }, anchors };
    },
  }), [input.scroll]);
  const reveal = (messageId: string, trigger: HTMLElement, keyboard: boolean) => {
    const occurrence = occurrences.find(value => value.message.id === messageId);
    if (!occurrence) return;
    input.scroll.releaseFollowing();
    demanded.current = { messageId, scrollTop: null };
    setRequest({ key: occurrence.key, keyboard, control: null, reveal: true });
    runtime.requestSecondarySurface("librarian-references", { returnFocusTo: trigger });
  };
  useLayoutEffect(() => { paint(active.current); });
  const afterPaneLayout = useCallback(() => {
    paint(active.current);
    const port = list.current;
    if (!open || !port?.isConnected || !port.getClientRects().length) return;
    const restoring = restore.current;
    if (restoring && input.ready) {
      memory.current = { ...memory.current, focus: restoring.focus, anchor: restoring.anchor };
      if ((!column || mode === "all") && restoring.anchor) {
        const row = rowFor(restoring.anchor.occurrenceKey, port);
        if (row) port.scrollTop += row.getBoundingClientRect().top - port.getBoundingClientRect().top - restoring.anchor.offsetPx;
      }
      if (restoring.focus && occurrences.some(row => row.key === restoring.focus!.occurrenceKey) && !focusOccurrence(restoring.focus.occurrenceKey, restoring.focus.control)) return;
      restore.current = null;
    }
  }, [column, focusOccurrence, input.ready, mode, occurrences, open, paint]);
  useLayoutEffect(() => {
    const clear = (event: Event) => {
      const target = event.target;
      if (event.type === "focusin" && target instanceof Element && keyOf(target) !== null &&
        (current.current.transcript.current?.contains(target) || pane.current?.contains(target))) return;
      memory.current = { ...memory.current, focus: null }; save(memory.current);
    };
    document.addEventListener("focusin", clear);
    document.addEventListener("pointerdown", clear, true);
    return () => { document.removeEventListener("focusin", clear); document.removeEventListener("pointerdown", clear, true); };
  }, [save]);
  const previousHost = useRef(open && column);
  useLayoutEffect(() => {
    const host = open && column;
    if (previousHost.current === host) return;
    previousHost.current = host;
    const focused = memory.current.focus;
    if (!focused) return;
    if (host) setRequest({ key: focused.occurrenceKey, keyboard: true, control: focused.control, reveal: false });
    else focusOccurrence(focused.occurrenceKey, focused.control);
  }, [open, column, focusOccurrence]);
  usePaneCompanion(useMemo(() => ({
    groupId: "librarian-inspector" as const, defaultSurfaceId: "librarian-references" as const,
    surfaces: [{ id: "librarian-references" as const, body: <LibrarianReferences
      occurrences={occurrences} ready={input.ready} source={source} mode={mode} setMode={setMode}
      pane={pane} list={list} interactions={interactions} onScroll={rememberList} onLayout={afterPaneLayout} request={request}
      completeRequest={() => setRequest(null)} heldFocus={memory.current.focus?.occurrenceKey ?? restore.current?.focus?.occurrenceKey ?? null}
      inspect={() => input.scroll.releaseFollowing()} showMessage={occurrence => {
        const target = input.scroll.inspectReference(occurrence.message.id, "target" in occurrence.value ? occurrence.value.id : null);
        if (target) { target.tabIndex = -1; runtime.revealPrimary({ focusTarget: target }); }
      }} /> }],
  }), [occurrences, input.ready, input.scroll, source, mode, request, runtime, interactions, rememberList, afterPaneLayout]));
  return { inlineAttachments: !(open && column), reveal, interactions };
}

function LibrarianReferences({ occurrences, ready, source, mode, setMode, pane, list, interactions, onScroll, onLayout, request, completeRequest, heldFocus, inspect, showMessage }: {
  occurrences: readonly ReferenceOccurrence[]; ready: boolean; source: MarginSource; mode: Memory["mode"]; setMode(value: Memory["mode"]): void;
  pane: RefObject<HTMLDivElement | null>; list: RefObject<HTMLDivElement | null>;
  interactions: { onFocusCapture(event: FocusEvent<HTMLElement>): void; onPointerDownCapture(): void; onMouseOver(event: MouseEvent<HTMLElement>): void; onMouseLeave(): void };
  onScroll(): void; onLayout(): void; request: RevealRequest | null; completeRequest(): void; heldFocus: string | null;
  inspect(): void; showMessage(occurrence: ReferenceOccurrence): void;
}) {
  const presentation = useCompanionPresentation();
  const aligned = presentation === "Column" && mode === "margin";
  const root = useRef<HTMLDivElement>(null);
  const retainedKeys = () => {
    const keys = new Set<string>();
    if (request) keys.add(request.key);
    if (heldFocus) keys.add(heldFocus);
    for (const opener of [document.activeElement, ...getOverlayOpeners()]) {
      if (!(opener instanceof HTMLElement) || !list.current?.contains(opener)) continue;
      const key = opener.closest<HTMLElement>("[data-reference-key]")?.dataset.referenceKey;
      if (key) keys.add(key);
    }
    return keys;
  };
  const { placements, reveal } = useMarginLayout({ active: aligned && ready, source, outer: pane, list, root, retainedKeys });
  const byKey = new Map(occurrences.map(occurrence => [occurrence.key, occurrence]));
  const rows = aligned ? placements.flatMap(placement => {
    const occurrence = byKey.get(placement.key);
    return occurrence ? [{ occurrence, placement }] : [];
  }) : occurrences.map(occurrence => ({ occurrence, placement: null }));
  // Publication can precede the shell's portal admission. Restore only from
  // this committed host; later placement commits also finish keyboard focus.
  useLayoutEffect(onLayout);
  useLayoutEffect(() => {
    if (!request || !list.current) return;
    const row = list.current.querySelector<HTMLElement>(`[data-reference-key="${CSS.escape(request.key)}"]`);
    if (!row) { if (ready && !byKey.has(request.key)) completeRequest(); return; }
    if (aligned && !placements.some(placement => placement.key === request.key && placement.kind === "placed")) return;
    const port = list.current;
    if (request.reveal) {
      if (aligned) { if (!reveal(request.key)) return; }
      else port.scrollTop += row.getBoundingClientRect().top - port.getBoundingClientRect().top;
    }
    if (request.keyboard) {
      const control = request.control === null ? null : request.control.kind === "named"
        ? row.querySelector<HTMLElement>(`[data-reference-control="${CSS.escape(request.control.id)}"]`)
        : row.querySelector<HTMLElement>(`a[href="${CSS.escape(request.control.href)}"]`);
      (control ?? (!request.reveal ? row.querySelector<HTMLElement>("a[href], button") : null) ?? row.querySelector<HTMLElement>("figure") ?? row).focus({ preventScroll: true });
    }
    completeRequest();
  });
  return <div ref={pane} className={styles.references} {...interactions}
    onWheel={inspect} onTouchMove={inspect} onPointerDown={inspect} onKeyDown={event => { if (!event.defaultPrevented) inspect(); }}>
    {presentation === "Column" ? <div className={styles.referenceModes}>
      <RadioGroup label="reference presentation" legend="Hidden" presentation="Segmented" value={mode} onChange={setMode}
        choices={[{ value: "margin", label: <>margin<span className="sr-only"> beside messages</span></> },
          { value: "all", label: <>all<span className="sr-only"> references in these messages</span></> }]} />
    </div> : null}
    <div ref={list} className={styles.referenceList} onScroll={onScroll}>
      {ready && rows.length === 0 ? <p className={styles.referenceEmpty}>{occurrences.length === 0 ? "no references in these messages." : <>no references here. <Button onClick={() => setMode("all")}>show all</Button></>}</p> : null}
      <div ref={root} className={styles.referenceRoot}><div className={styles.referenceStack} style={aligned ? { height: Math.max(0, ...placements.map(row => row.kind === "placed" ? row.offset + row.height : 0)) } : undefined}>
        {rows.map(({ occurrence, placement }, index) => <div key={occurrence.key} data-margin-key={occurrence.key} data-reference-key={occurrence.key}
          className={styles.referenceOccurrence} style={placement ? { position: "absolute", top: placement.kind === "placed" ? placement.offset : 0, visibility: placement.kind === "measuring" ? "hidden" : undefined } : undefined}>
          {!aligned && (index === 0 || rows[index - 1].occurrence.message.id !== occurrence.message.id) ? <div className={styles.referenceContext}>
            <span>{occurrence.message.role === "user" ? "you" : "librarian"}</span>
            {occurrence.message.content.trim() ? occurrence.message.role === "user" ? <TextPreview content={occurrence.message.content} /> : <MarkdownPreview content={occurrence.message.content} /> : null}
          </div> : null}
          <ReferenceFigure value={occurrence.value} />
          <Button data-reference-control="message" className={styles.showMessage} onClick={() => showMessage(occurrence)}>show message</Button>
        </div>)}
      </div></div>
    </div>
  </div>;
}
