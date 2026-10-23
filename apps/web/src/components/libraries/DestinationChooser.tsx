"use client";

import { forwardRef, type MouseEventHandler } from "react";
import { ChevronDown } from "lucide-react";
import LibraryChooser, { compareLibraryNames, type ChooserCreation, type ChooserError, type ChooserRow } from "@/components/libraries/LibraryChooser";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue, useThrowLater } from "@/lib/api/serverState";
import { useUnauthenticatedApiHandler } from "@/lib/auth/UnauthenticatedApiBoundary";
import { libraryDestinations, type LibraryDestination } from "@/lib/libraries/api";
import { libraryErrorFeedback } from "@/lib/libraries/errors";
import styles from "./DestinationChooser.module.css";

export type DestinationChange = { destination: LibraryDestination; included: boolean };
export function setDestination(current: readonly LibraryDestination[], { destination, included }: DestinationChange): readonly LibraryDestination[] {
  return included ? current.some(item => item.id === destination.id) ? current : [...current, destination]
    : current.filter(item => item.id !== destination.id);
}
export type DestinationSelection =
  | { readonly kind: "Item"; readonly chosen: readonly LibraryDestination[] }
  | { readonly kind: "Bulk"; readonly total: number; readonly entries: readonly { destination: LibraryDestination; included: number }[] };

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
  const summary = names.length === 0 ? props.emptyLabel : names.length <= 2 ? names.join(", ") : `${names[0]}, ${names[1]} +${names.length - 2}`;
  return <button ref={ref} type="button" className={styles.trigger} aria-expanded={props.expanded}
    aria-haspopup={props.controls.kind === "dialog" ? "dialog" : undefined}
    aria-controls={props.controls.kind === "region" ? props.controls.id : undefined}
    aria-label={`${props.accessibleLabel ?? props.label}: ${names.length === 0 ? props.emptyLabel : names.join(", ")}`}
    disabled={props.disabled} onClick={props.onToggle}>
    <span className={styles.label}>{props.label}</span><span className={styles.summary}>{summary}</span>
    <ChevronDown size={15} aria-hidden="true" data-open={props.expanded || undefined} />
  </button>;
});

/** Local draft selection over one complete writable catalog. Reads belong to serverState. */
export default function DestinationChooser({ context, selection, onSet, disabled, create, error, status }: {
  readonly context: string;
  readonly selection: DestinationSelection;
  readonly onSet: (change: DestinationChange) => boolean;
  readonly disabled: boolean;
  readonly create: ChooserCreation | null;
  readonly error?: ChooserError | null;
  readonly status?: string;
}) {
  const stamp = useChangeStamp("Libraries");
  const catalog = usePaneFreeServerValue({ key: "/libraries/destinations", stale: stamp, load: libraryDestinations });
  const fail = useThrowLater();
  const signIn = useUnauthenticatedApiHandler();
  const total = selection.kind === "Item" ? 1 : selection.total;
  const entries = selection.kind === "Item"
    ? selection.chosen.map(destination => ({ destination, included: 1 })) : selection.entries;
  const byId = new Map(entries.map(entry => [entry.destination.id, entry]));
  const available = new Map(catalog.status === "ready" ? catalog.data.destinations.map(destination => [destination.id, destination]) : []);
  const all = new Map(available);
  for (const entry of entries) if (!all.has(entry.destination.id)) all.set(entry.destination.id, entry.destination);
  const rows: ChooserRow[] = [...all.values()].map(destination => {
    const included = byId.get(destination.id)?.included ?? 0;
    const missing = !available.has(destination.id);
    const desired = !missing && included < total;
    const count = { included, total };
    return {
      id: destination.id, name: destination.name, confirmed: count, intended: count, progress: "Settled",
      note: missing && catalog.status === "ready" ? "unavailable" : undefined,
      action: disabled || total === 0 ? { kind: "Blocked", reason: "these items cannot be changed now" }
        : { kind: "Set", included: desired, label: total === 1 ? desired ? "choose destination" : "remove destination" : desired ? "choose for all" : "remove from all" },
    };
  });
  const readError = catalog.status === "failed" ? catalog.error : catalog.status === "ready" ? catalog.error : null;
  const feedback = readError ? libraryErrorFeedback(readError, "libraries couldn’t be loaded", fail, signIn) : null;
  const names = entries.filter(entry => entry.included > 0).map(entry => entry.destination).toSorted(compareLibraryNames).map(destination => destination.name);
  return <LibraryChooser context={context} membershipKind="Chosen" rows={rows}
    onToggle={({ id, included }) => {
      const destination = all.get(id);
      return destination !== undefined && !disabled && onSet({ destination, included });
    }}
    loading={catalog.status === "loading" || catalog.status === "failed" && catalog.retrying || catalog.status === "ready" && catalog.refreshing}
    summary={selection.kind === "Bulk" ? `applies to ${total} editable items · selected libraries: ${names.join(", ") || "none"}` : null}
    status={status}
    error={error ?? (feedback ? { content: feedback, retry: readError?.code === "E_UNAUTHENTICATED" ? null : catalog.refetch, commandKey: "library-destinations", busy: catalog.status === "failed" ? catalog.retrying : catalog.status === "ready" && catalog.refreshing } : null)}
    create={create === null ? null : { ...create, available: create.available && !disabled && total > 0 && catalog.status === "ready" && !catalog.refreshing && catalog.error === null }}
    empty="no libraries yet" />;
}
