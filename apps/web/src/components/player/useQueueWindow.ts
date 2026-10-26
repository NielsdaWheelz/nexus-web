"use client";

/** A complete queue's measured window. Compact queue rows have uniform border-box
 * geometry: bounded title/metadata lines, no artwork or expanded content. Only an
 * actual row supplies height. Ordered presentation gaps account for omitted ranks;
 * endpoints and focused/menu neighbors preserve native Tab order and exact nodes.
 * One observer/scroll lifetime owns geometry and the visible occurrence anchor. */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { QueueManifest } from "@/lib/player/queue";
import { windowRange, windowRanks } from "@/lib/collections/collectionWindow";

export function useQueueWindow({ manifest, root, scrollport, openingEntryId, focusedEntryId, menuEntryId, recoveryEntryIds }: {
  readonly manifest: QueueManifest | null;
  readonly root: RefObject<HTMLElement | null>;
  readonly scrollport: (section: HTMLElement) => HTMLElement | null;
  readonly openingEntryId: string | null;
  readonly focusedEntryId: string | null;
  readonly menuEntryId: string | null;
  readonly recoveryEntryIds: readonly string[];
}) {
  const byId = useMemo(() => new Map(manifest?.entries.map((entry, index) => [entry.id, { entry, index }]) ?? []), [manifest]);
  const count = manifest?.entries.length ?? 0;
  const [view, setView] = useState<{ height: number | null; start: number; end: number }>({ height: null, start: 0, end: 0 });
  const nodes = useRef(new Map<string, HTMLElement>());
  const anchor = useRef<{ queueId: string; id: string; offset: number } | null>(null);
  const measured = useRef<{ manifest: QueueManifest | null; height: number; width: number; viewport: number; listTop: number } | null>(null);
  const pendingScroll = useRef<number | null>(null);
  const work = useRef<((height: number | null) => void) | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const ownedPort = useRef<HTMLElement | null>(null);
  const probe = useRef<HTMLElement | null>(null);
  const initialized = useRef(false);
  const rowElement = useCallback((id: string) => nodes.current.get(id) ?? null, []);
  let start = Math.min(view.start, count);
  let end = Math.min(view.end, count);
  const saved = anchor.current;
  const previous = measured.current;
  // A reordered anchor must be mounted in the very commit that changes its rank.
  if (view.height !== null && previous?.manifest !== manifest && saved !== null && saved.queueId === manifest?.queue_id) {
    const position = byId.get(saved.id)?.index;
    if (position !== undefined) ({ start, end } = windowRange({ top: position * view.height - saved.offset, viewport: previous?.viewport ?? 0, height: view.height, count }));
  }
  const pinnedRanks = [openingEntryId, focusedEntryId, menuEntryId, ...recoveryEntryIds]
    .flatMap(id => { const index = id === null ? undefined : byId.get(id)?.index; return index === undefined ? [] : [index]; });
  const { rows: ranks, demand } = windowRanks({ start, end, count, pinnedRanks,
    retainedRanks: view.height === null && count > 0 && pinnedRanks.length === 0 && start === end ? [0] : [] });
  const rows = ranks.map(({ index, gap }) => ({ entry: manifest!.entries[index], index, gap }));

  useLayoutEffect(() => {
    const section = root.current;
    ownedPort.current = section === null ? null : scrollport(section);
    nodes.current = new Map([...section!.querySelectorAll<HTMLElement>("[data-collection-row-id]")].map(row => [row.dataset.collectionRowId!, row]));
    work.current = observedHeight => {
      const port = ownedPort.current;
      const list = section?.querySelector<HTMLElement>("ul");
      const sample = list?.querySelector<HTMLElement>("[data-collection-row-id]") ?? null;
      if (sample !== probe.current) {
        if (probe.current !== null) observer.current?.unobserve(probe.current);
        probe.current = sample;
        if (sample !== null) observer.current?.observe(sample);
      }
      if (port === null || list === null || list === undefined || sample === null || manifest === null) return;
      if (pendingScroll.current !== null && view.height !== null) {
        port.scrollTop = pendingScroll.current;
        pendingScroll.current = null;
      }
      const height = observedHeight ?? view.height;
      if (height === null || height <= 0 || port.clientHeight === 0) return;
      // The composition shares one offset parent. Far-offscreen DOMRects lose
      // fractional precision; only local layout offsets and observed box size own geometry.
      if (list.offsetParent !== port.offsetParent) throw new Error("queue list and scrollport must share an offset parent");
      const listTop = list.offsetTop - port.offsetTop - port.clientTop;
      const before = measured.current;
      const retained = anchor.current;
      const changed = before !== null && (before.manifest !== manifest || before.height !== height
        || before.width !== port.clientWidth || before.viewport !== port.clientHeight || before.listTop !== listTop);
      let top = port.scrollTop;
      if (changed && retained?.queueId === manifest.queue_id) {
        const index = byId.get(retained.id)?.index;
        if (index !== undefined) top = Math.max(0, listTop + index * height - retained.offset);
      } else if (!initialized.current && openingEntryId !== null) {
        const index = byId.get(openingEntryId)?.index;
        if (index !== undefined) top = Math.max(0, listTop + index * height - (port.clientHeight - height) / 2);
      }
      const bounds = windowRange({ top: top - listTop, viewport: port.clientHeight, height, count });
      measured.current = { manifest, height, width: port.clientWidth, viewport: port.clientHeight, listTop };
      if (height !== view.height || bounds.start !== view.start || bounds.end !== view.end) {
        pendingScroll.current = top;
        setView({ height, ...bounds });
        return;
      }
      initialized.current = true;
      if (port.scrollTop !== top) port.scrollTop = top;
      // No queue anchor exists while the player transport wholly precedes the list.
      const relative = port.scrollTop - listTop;
      if (relative + port.clientHeight <= 0 || relative >= count * height) { anchor.current = null; return; }
      const index = Math.max(0, Math.min(count - 1, Math.floor(relative / height)));
      anchor.current = { queueId: manifest.queue_id, id: manifest.entries[index].id, offset: listTop + index * height - port.scrollTop };
    };
    work.current(null);
  });

  useLayoutEffect(() => {
    const port = ownedPort.current;
    if (port === null || root.current === null) return;
    let frame: number | null = null;
    const resize = new ResizeObserver(changes => {
      const sample = changes.find(change => change.target === probe.current);
      flushSync(() => work.current?.(sample?.borderBoxSize[0].blockSize ?? null));
    });
    observer.current = resize;
    resize.observe(port);
    resize.observe(root.current);
    resize.observe(root.current.parentElement!);
    if (probe.current !== null) resize.observe(probe.current);
    const scroll = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        flushSync(() => work.current?.(null));
      });
    };
    port.addEventListener("scroll", scroll, { passive: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      port.removeEventListener("scroll", scroll);
      resize.disconnect();
      observer.current = null;
      work.current = null;
    };
  }, [root]);

  return { byId, rows, demand: demand.map(index => manifest!.entries[index]),
    height: view.height, geometryReady: view.height !== null || count === 0, rowElement };
}
