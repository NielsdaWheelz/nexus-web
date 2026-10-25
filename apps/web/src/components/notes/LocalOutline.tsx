"use client";
/** Ordered local user relationships. One exact occurrence owns structural keys;
 * repeated appearances share content, while unlink and join name their own ids. */
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import ResourceOutlineList from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import ResourceComposer from "@/components/resources/ResourceComposer";
import BoundNoteEditor from "./BoundNoteEditor";
import { useAuthoredPages, useWritingRuntime } from "@/lib/notes/hooks";
import { OutlineHistory } from "@/lib/notes/structure";
import { LocalCommitError, selectStates } from "@/lib/notes/runtime";
import type { Intent } from "@nexus/authored/commands";
import type { LinkState } from "@nexus/authored/types";
const HistoryContext = createContext<OutlineHistory | null>(null);
export interface LocalOutlineHandle { append(): Promise<void>; focusNote(ref: string): boolean; focusFirst(): void }
const CLIPBOARD = "application/x-nexus-local-outline";
export default function LocalOutline({ rootRef, ancestors = [], prelude = [], apiRef, filter = "" }: { rootRef: string; ancestors?: readonly string[]; prelude?: readonly Intent[]; apiRef?: React.RefObject<LocalOutlineHandle | null>; filter?: string }) {
  const runtime = useWritingRuntime();
  const inherited = useContext(HistoryContext);
  const [error, setError] = useState<unknown | null>(null);
  const own = useMemo(() => runtime ? new OutlineHistory(runtime, setError) : null, [runtime]);
  const history = inherited ?? own;
  useEffect(() => () => { if (!inherited) own?.close(); }, [inherited, own]);
  const read = useAuthoredPages({ kind: "adjacency", ref: rootRef, cursor: null, limit: 100 });
  const rows = read.data?.rows ?? [];
  const links = rows.flatMap(row => row.link ? [row.link] : []);
  const [selected, setSelected] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const act = (operation: Promise<unknown>) => { setError(null); void operation.catch(setError); };
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const focusNote = (ref: string): boolean => {
    const row = [...surface.current?.querySelectorAll<HTMLElement>("[data-resource-ref]") ?? []].find(row => row.dataset.resourceRef === ref);
    const editor=row?.querySelector<HTMLElement>('[role="textbox"]');
    editor?.focus();
    return editor!==null && editor!==undefined;
  };
  const focus = (ref:string) => { if(!focusNote(ref)) setPendingFocus(ref); };
  useEffect(()=>{if(pendingFocus && focusNote(pendingFocus))setPendingFocus(null);});
  useLayoutEffect(()=>{
    if(!apiRef||!history)return;
    const handle:LocalOutlineHandle={append:async()=>focus(await history.create(rootRef,null,undefined,prelude)),focusNote,focusFirst:()=>{const first=rows[0];if(first)focus(first.resource.ref);}};
    apiRef.current=handle;
    return()=>{if(apiRef.current===handle)apiRef.current=null;};
  });
  const outdent = (link: LinkState) => {
    const parent = ancestors.filter(ref => ref !== rootRef).at(-1);
    if (parent && history) act(history.relink(link, rootRef, parent));
  };
  if (!runtime || !history) return null;
  return <HistoryContext value={history}><div ref={surface}>
    {read.error ? <div role="alert"><p>couldn’t open these links on this device.</p><Button onClick={read.retry}>retry</Button></div> : null}
    {error ? <div role="alert"><p>{error instanceof Error ? error.message : "this change couldn’t be saved on this device."}</p>{error instanceof LocalCommitError ? <Button onClick={() => { void error.retry().then(() => setError(null), setError); }}>retry saving</Button> : null}</div> : null}
    <ResourceOutlineList scope={`local:${rootRef}`} ariaLabel="linked resources" ancestorRef={rootRef}>
      {rows.map((row, index) => {
        const link = row.link!;
        const ref = row.resource.ref;
        const previous = rows[index - 1];
        const indent = () => { if (previous?.resource.kind === "note") act(history.relink(link, rootRef, previous.resource.ref)); };
        const move = (direction: number) => {
          const position = index + direction;
          if (position >= 0 && position < links.length) act(history.move(link, rootRef, links, position));
        };
        const join = () => { if (previous?.resource.kind === "note" && ref !== previous.resource.ref) act(history.join(previous.resource.ref, ref).then(() => focus(previous.resource.ref))); };
        if(filter.trim() && ![row.resource.title,row.resource.body_text,row.resource.selection?.quote_exact].some(value=>value?.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())))return null;
        return <ResourceOutlineRow key={link.link_id} resourceRef={ref} occurrenceKey={`${rootRef}/${link.link_id}`}
          incoming={{ kind: "link", link, parent_ref: rootRef, parent_label: rootRef }} editable={!filter.trim()}
          body={row.resource.kind === "note" ? <BoundNoteEditor noteRef={ref} session={history} editable={!filter.trim()} onSplit={position => act(history.split(ref, position, rootRef, link.link_id).then(focus))} onJoinPrevious={join}
            structuralKeys={{ indent, outdent: () => outdent(link), selectBlock: () => setSelected(link.link_id) }} /> : undefined}
          rootProps={{
            "data-selected": selected === link.link_id,
            onFocus: () => setSelected(link.link_id),
            draggable: true,
            onDragStart: event => { if (event.target instanceof Element && event.target.closest('[role="textbox"]')) return; event.dataTransfer.setData(CLIPBOARD, JSON.stringify({ link_id: link.link_id, parent_ref: rootRef })); },
            onDragOver: event => { if (event.dataTransfer.types.includes(CLIPBOARD)) event.preventDefault(); },
            onDrop: event => {
              if (!event.dataTransfer.types.includes(CLIPBOARD)) return;
              event.preventDefault(); event.stopPropagation();
              let value: unknown;
              try { value = JSON.parse(event.dataTransfer.getData(CLIPBOARD)); } catch { return; }
              if (!value || typeof value !== "object" || !("link_id" in value) || !("parent_ref" in value) || typeof value.link_id !== "string" || typeof value.parent_ref !== "string") return;
              const id = value.link_id, parent = value.parent_ref;
              act((async () => {
                const state = await (await runtime.store).readStates(selectStates({ link_ids: [id] }));
                const dragged = state.links[0];
                if (!dragged || id === link.link_id) return;
                if (parent !== rootRef) await history.relink(dragged, parent, rootRef);
                else await history.move(dragged, rootRef, links, index);
              })());
            },
            onKeyDown: event => {
              if (filter.trim() || event.defaultPrevented || event.nativeEvent.isComposing) return;
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) history.redo(); else history.undo(); return; }
              if (event.altKey && event.shiftKey && event.key === "ArrowUp") { event.preventDefault(); move(-1); return; }
              if (event.altKey && event.shiftKey && event.key === "ArrowDown") { event.preventDefault(); move(1); return; }
              if (event.target instanceof Element && event.target.closest('[role="textbox"]')) return;
              if (event.key === "Tab") { event.preventDefault(); if (event.shiftKey) outdent(link); else indent(); }
              else if (event.key === "Backspace" || event.key === "Delete") { event.preventDefault(); act(history.unlink(link)); }
              else if (event.key === "Enter") { event.preventDefault(); act(history.create(rootRef, link.link_id).then(focus)); }
            },
          }} />;
      })}
    </ResourceOutlineList>
    {read.data?.next_cursor !== null && read.data !== null ? <Button onClick={read.more}>show more</Button> : null}
    {!filter.trim() ? <ResourceComposer destinationRef={rootRef} occurrenceKey={`local:${rootRef}:insert`} label="add a note or link" prelude={prelude} afterSave="clear" /> : null}
  </div></HistoryContext>;
}
