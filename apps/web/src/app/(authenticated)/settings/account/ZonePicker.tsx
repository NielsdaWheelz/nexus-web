"use client";

import { useId, useRef, useState, type RefObject } from "react";
import * as Icon from "@/lib/ui/icons";
import { Fact } from "@/components/feedback/Fact";
import Input from "@/components/ui/Input";
import PickerSurface from "@/components/ui/PickerSurface";
import collection from "@/components/ui/Collection.module.css";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { listZones, zoneClock, zoneOf } from "@/lib/time/zones";
import { reconcileSearchActive, useSearchOptions, type SearchActive } from "@/lib/ui/searchOptions";
import styles from "./page.module.css";

/** mounted for one open: catalogue and clocks belong to that opening. */
export default function ZonePicker({ current, device, anchor, onPick, onClose }: {
  current: string;
  device: string | null;
  anchor: RefObject<HTMLButtonElement | null>;
  onPick(id: string): void;
  onClose(): void;
}) {
  const { displayLocale } = useRenderEnvironment();
  const id = useId();
  const composing = useRef(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<SearchActive>(null);
  const canonical = zoneOf(current).id;
  const offered = device === null ? null : zoneOf(device).id;
  const [zones] = useState(() => {
    const at = new Date();
    return listZones(device === null ? [current] : [current, device]).map(zone => {
      const clock = zoneClock(zone.id, at, displayLocale);
      return { ...zone, clock, search: `${zone.city} ${zone.region} ${zone.id} ${clock?.offset ?? ""} ${clock?.offset === "GMT" ? "UTC+0" : clock?.offset.replace(/^GMT/, "UTC") ?? ""}`.toLowerCase() };
    });
  });
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const results = zones.filter(zone => words.every(word => zone.search.includes(word)));
  if (words.length === 0 && offered !== null && offered !== canonical) {
    const index = results.findIndex(zone => zone.id === offered);
    if (index > 0) results.unshift(...results.splice(index, 1));
  }
  const options = results.map(zone => ({ key: zone.id, disabledReason: null }));
  const initialKey = words.length > 0 ? results[0]?.id ?? null : offered !== null && offered !== canonical ? offered : canonical;
  const selected = reconcileSearchActive({ context: query, admitted: true, options, initialKey, active });
  if (selected !== active) setActive(selected);
  const navigation = useSearchOptions<HTMLUListElement>({
    listId: `${id}-list`, label: "calendar time zone", open: true, options, activeKey: selected?.key ?? null,
    onActiveChange: key => setActive({ context: query, key }),
    onActivate: onPick,
  });
  return <PickerSurface active anchor={() => anchor.current} onClose={onClose} title="calendar time zone" align="end" className={styles.zonePicker}>
    <Input type="search" {...navigation.inputProps} className={collection.search}
      aria-label="calendar time zone" placeholder="city, region or offset" value={query}
      onChange={event => setQuery(event.target.value)}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (navigation.handleKey(event.nativeEvent, composing.current)) { event.preventDefault(); event.stopPropagation(); }
      }} />
    <ul ref={navigation.listRef} {...navigation.listProps} className={collection.compactViewport}>
      {results.map(zone => <li key={zone.id} {...navigation.optionProps(zone.id)} className={collection.row} data-selected={zone.id === canonical || undefined}>
        <span className={collection.content}><span>{zone.city}</span>
          <span className={collection.detail}>{words.length === 0 && zone.id === offered && offered !== canonical ? "this device" : zone.region}</span>
        </span>
        {zone.clock ? <span className={styles.zoneClock}>{zone.clock.offset}<br />{zone.clock.text.toLowerCase()}</span> : null}
        {zone.id === canonical ? <span className={collection.adornment}><Icon.Check size={16} aria-hidden="true" /><span className="sr-only">current</span></span> : null}
      </li>)}
    </ul>
    {results.length === 0 ? <Fact line={{ fact: "no time zone matches." }} speak /> : null}
  </PickerSurface>;
}
