"use client";
import * as Icon from "@/lib/ui/icons";

import { forwardRef, type MouseEventHandler, type RefObject } from "react";
import { Failed } from "@/components/feedback/Fact";
import LibraryChooser, { type ChooserCreation, type ChooserRow } from "@/components/libraries/LibraryChooser";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { libraryDestinations, type LibraryDestination } from "@/lib/libraries/api";
import { compareLibraryNames, libraryNames } from "@/lib/libraries/views";
import styles from "./DestinationChooser.module.css";

export type DestinationChange = { destination: LibraryDestination; included: boolean };
export function setDestination(current: readonly LibraryDestination[], { destination, included }: DestinationChange): readonly LibraryDestination[] {
  return included ? current.some(item => item.id === destination.id) ? current : [...current, destination]
    : current.filter(item => item.id !== destination.id);
}
export const DestinationTrigger = forwardRef<HTMLButtonElement, {
  readonly label: string;
  readonly accessibleLabel?: string;
  readonly emptyLabel: string;
  readonly chosen: readonly LibraryDestination[];
  readonly expanded: boolean;
  readonly disabled: boolean;
  readonly onToggle: MouseEventHandler<HTMLButtonElement>;
  readonly controls: { readonly kind: "dialog" } | { readonly kind: "region"; readonly id: string };
}>(function DestinationTrigger(props, ref) {
  const names = props.chosen.toSorted(compareLibraryNames).map(library => library.name);
  const summary = names.length === 0 ? props.emptyLabel : libraryNames(props.chosen);
  return <button ref={ref} type="button" className={styles.trigger} aria-expanded={props.expanded}
    aria-haspopup={props.controls.kind === "dialog" ? "dialog" : undefined}
    aria-controls={props.controls.kind === "region" ? props.controls.id : undefined}
    aria-label={`${props.accessibleLabel ?? props.label}: ${names.length === 0 ? props.emptyLabel : names.join(", ")}`}
    disabled={props.disabled} onClick={props.onToggle}>
    <span className={styles.label}>{props.label}</span><span className={styles.summary}>{summary}</span>
    <Icon.Choose size={16} aria-hidden="true" />
  </button>;
});

/** Local draft selection over one complete writable catalog. Reads belong to serverState; a cold
 * read waits and fails in the list region, a refresh does both nowhere, though creation, which
 * needs the current catalog, waits on it and says so. */
export default function DestinationChooser({ context, chosen, alwaysIncludesAll = false, onSet, disabled, create, scrollRef }: {
  readonly context: string;
  readonly scrollRef?: RefObject<HTMLDivElement | null>;
  readonly chosen: readonly LibraryDestination[];
  readonly alwaysIncludesAll?: boolean;
  readonly onSet: (change: DestinationChange) => boolean;
  readonly disabled: boolean;
  readonly create: ChooserCreation | null;
}) {
  const stamp = useChangeStamp("Libraries");
  const catalog = usePaneFreeServerValue({ key: "/libraries/destinations", stale: stamp, load: libraryDestinations });
  const chosenIds = new Set(chosen.map(destination => destination.id));
  const available = new Map(catalog.status === "ready" ? catalog.data.destinations.map(destination => [destination.id, destination]) : []);
  const all = new Map(available);
  for (const destination of chosen) if (!all.has(destination.id)) all.set(destination.id, destination);
  const rows: ChooserRow[] = [...all.values()].map(destination => {
    const included = chosenIds.has(destination.id);
    const missing = !available.has(destination.id);
    const desired = !missing && !included;
    const count = { included: included ? 1 : 0, total: 1 };
    return {
      id: destination.id, name: destination.name, confirmed: count, intended: count, progress: "Settled",
      note: missing && catalog.status === "ready" ? "unavailable" : undefined,
      action: disabled ? { kind: "Blocked", reason: "can’t change these right now." }
        : { kind: "Set", included: desired, label: desired ? "choose destination" : "remove destination" },
    };
  });
  return <LibraryChooser scrollRef={scrollRef} context={context} membershipKind="Chosen" rows={rows} alwaysIncludesAll={alwaysIncludesAll}
    onToggle={({ id, included }) => {
      const destination = all.get(id);
      return destination !== undefined && !disabled && onSet({ destination, included });
    }}
    loading={catalog.status === "loading" || catalog.status === "failed" && catalog.retrying}
    summary={null}
    failure={catalog.status === "failed" ? <Failed error={catalog.error} noun="libraries" retry={{ run: catalog.refetch, busy: catalog.retrying }} /> : null}
    create={create === null ? null : { ...create, available: create.available && !disabled && catalog.status === "ready" && !catalog.refreshing && catalog.error === null,
      gate: catalog.status === "ready" && catalog.error !== null ? "the libraries couldn’t refresh." : undefined }}
    empty="no libraries yet." />;
}
