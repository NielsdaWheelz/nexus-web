"use client";

/** A file or unresolved rows remain a review until the immutable batch is acknowledged. Folder paths
 * choose flat library destinations; they never silently create subscriptions. */
import { useLayoutEffect, useRef, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Select from "@/components/ui/Select";
import LibraryChooser from "@/components/libraries/LibraryChooser";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { getDefaultFeedLibrary, previewOpml } from "@/lib/feeds/api";
import { libraryDestinations } from "@/lib/libraries/api";
import type { Schema } from "@/lib/api/wire";
import CommandRefusal from "./CommandRefusal";
import styles from "./FeedCommands.module.css";

export type OpmlReviewInput =
  | { readonly kind: "File"; readonly file: File }
  | { readonly kind: "UnresolvedRows"; readonly rows: readonly Pick<Schema<"OpmlImportItemOut">, "url" | "selected_kind" | "library_id">[] };

export default function OpmlImportDialog({ input, onClose }: { readonly input: OpmlReviewInput; readonly onClose: () => void }) {
  const { ctx } = useActionRuntime();
  const live = useRef(false);
  const [batchId] = useState(() => crypto.randomUUID());
  const subject = `opml:${batchId}`;
  const pending = ctx.feeds.pending(subject);
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set());
  const [kinds, setKinds] = useState<ReadonlyMap<number, "podcast" | "article" | null>>(new Map());
  const [destinations, setDestinations] = useState<ReadonlyMap<string, { id: string; name: string }>>(new Map());
  const [choosing, setChoosing] = useState<string | null>(null);
  const creation = ctx.feedLibraryCreation.forScope(subject);
  const tooLarge = input.kind === "File" && input.file.size > 1024 * 1024;
  const title = input.kind === "File" ? input.file.name : "unresolved subscriptions";
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const read = usePaneFreeServerValue({ key: tooLarge ? null : `opml-preview:${batchId}`, stale: "",
    load: async signal => {
      const seen = new Map<string, number>();
      const preview = input.kind === "File" ? input.file.text().then(xml => previewOpml(xml, signal)) : Promise.resolve({
        rows: input.rows.map((row, ordinal): Schema<"OpmlPreviewRow"> => {
          const duplicate_of = seen.get(row.url) ?? null;
          if (duplicate_of === null) seen.set(row.url, ordinal);
          return { ordinal, title: row.url, url: row.url, folder_path: [row.library_id], duplicate_of, error: null };
        }),
      });
      const [review, catalog, defaultId] = await Promise.all([preview, libraryDestinations(signal), getDefaultFeedLibrary(signal)]);
      return { preview: review, catalog, defaultId };
    },
  });
  const current = read.status === "ready" ? read.data : null;
  const rows = current?.preview.rows ?? [];
  const destinationChoices = current === null ? [] : [{ id: current.defaultId, name: "all" }, ...current.catalog.destinations];
  const destinationFor = (path: string, ordinal: number) => {
    const id = destinations.get(path)?.id ?? (input.kind === "File" ? current?.defaultId : input.rows[ordinal]?.library_id);
    return destinationChoices.find(destination => destination.id === id) ?? null;
  };
  const kindFor = (ordinal: number) => kinds.has(ordinal) ? kinds.get(ordinal) ?? null
    : input.kind === "UnresolvedRows" ? input.rows[ordinal]?.selected_kind ?? null : null;
  const pairs = new Set<string>();
  const duplicates = new Set<number>();
  for (const row of rows) {
    if (row.url === null) continue;
    const path = JSON.stringify(row.folder_path);
    const pair = JSON.stringify([row.duplicate_of ?? row.ordinal, destinationFor(path, row.ordinal)?.id ?? path]);
    if (pairs.has(pair)) duplicates.add(row.ordinal);
    else pairs.add(pair);
  }
  const selected = rows.filter(row => !duplicates.has(row.ordinal) && !excluded.has(row.ordinal));
  const missingDestination = selected.some(row => destinationFor(JSON.stringify(row.folder_path), row.ordinal) === null);
  const invalid = missingDestination || selected.some(row => row.error !== null || row.url === null);
  const paths = [...new Map(rows.map(row => [JSON.stringify(row.folder_path), row])).entries()];
  const chosenDestination = choosing === null ? null : destinationFor(choosing, paths.find(([path]) => path === choosing)?.[1].ordinal ?? -1);
  const disabled = pending !== null || read.status !== "ready" || read.error !== null || read.refreshing;
  const choose = (id: string, name: string) => {
    if (choosing === null) return;
    setDestinations(previous => new Map(previous).set(choosing, { id, name }));
    setChoosing(null);
  };
  const submit = async () => {
    if (disabled || current === null || invalid || selected.length === 0) return;
    const items: Schema<"OpmlImportItemRequest">[] = selected.map(row => {
      const destination = destinationFor(JSON.stringify(row.folder_path), row.ordinal);
      if (row.url === null || destination === null) throw new Error("invalid OPML row reached confirmation");
      return { id: crypto.randomUUID(), url: row.url, selected_kind: kindFor(row.ordinal), library_id: destination.id,
        subscription_id: crypto.randomUUID(), initial_import_id: crypto.randomUUID() };
    });
    setChoosing(null);
    await ctx.feeds.submit({ subject, title, shown: () => live.current,
      command: { kind: "OpmlCreate", body: { id: batchId, expected_removal_revision: current.catalog.removal_revision, items } },
      onAccepted: () => { if (live.current) onClose(); },
    });
  };
  return <Dialog open title="import subscriptions" onClose={onClose}>
    <div className={styles.form}>
      <p>{title}</p>
      {tooLarge ? <Fact line={{ fact: "this opml file is over 1 mib." }} /> : read.status === "loading" ? <Ruling />
        : read.status === "failed" ? <Failed error={read.error} noun="subscription file" retry={{ run: read.refetch, busy: read.retrying }} /> : <>
          {read.error === null ? null : <Failed error={read.error} noun="the updated subscription review" retry={{ run: read.refetch, busy: read.refreshing }} />}
          <p>subscribe to {selected.length} sources. available history and future items will be added to their destination.</p>
          <p className={styles.note}>publisher history may be incomplete.{input.kind === "File" ? " folder paths select existing flat libraries; they do not create a hierarchy." : ""}</p>
          {input.kind === "UnresolvedRows" ? <p className={styles.note}>accepted subscriptions are kept. confirm only the unresolved sources below.</p> : null}
          {paths.map(([path, row], index) => {
            const destination = destinationFor(path, row.ordinal);
            const label = input.kind === "File" ? row.folder_path.join(" / ") || "unfiled"
              : destinationChoices.find(item => item.id === input.rows[row.ordinal]?.library_id)?.name ?? `unavailable library ${index + 1}`;
            return <div key={path} className={styles.actions}>
              <span>{label}</span>
              <Button aria-label={`destination for ${label}: ${destination?.name ?? "choose destination"}`} disabled={disabled} onClick={() => setChoosing(path)}>destination: {destination?.name ?? "choose destination"}</Button>
            </div>;
          })}
          {missingDestination ? <Fact line={{ fact: "choose a writable destination for each remaining group." }} /> : null}
          {choosing !== null && current !== null ? <LibraryChooser context={subject} membershipKind="Chosen"
            rows={destinationChoices.map(destination => ({ id: destination.id, name: destination.name,
              confirmed: { included: chosenDestination?.id === destination.id ? 1 : 0, total: 1 },
              intended: { included: chosenDestination?.id === destination.id ? 1 : 0, total: 1 }, progress: "Settled" as const,
              action: { kind: "Set" as const, included: true, label: "choose destination" } }))}
            onToggle={({ id }) => { choose(id, destinationChoices.find(destination => destination.id === id)?.name ?? "all"); return true; }}
            loading={false} summary={null} failure={null} empty="no writable libraries."
            create={{ available: !creation.creating, pendingNames: creation.pendingNames,
              onCreate: name => ctx.feedLibraryCreation.admit({ name, scope: subject, onCreated: destination => { if (live.current) { choose(destination.id, destination.name); void read.refetch().catch(() => {}); } } }) }} /> : null}
          <ul className={styles.destinations}>{rows.map(row => <li key={row.ordinal}>
            <label><input type="checkbox" checked={!duplicates.has(row.ordinal) && !excluded.has(row.ordinal)} disabled={disabled || duplicates.has(row.ordinal)}
              onChange={event => setExcluded(previous => { const next = new Set(previous); if (event.target.checked) next.delete(row.ordinal); else next.add(row.ordinal); return next; })} /> {row.title || row.url || "invalid source"}</label>
            {duplicates.has(row.ordinal) ? <span> · duplicate in this destination</span> : row.error !== null ? <span> · {row.error}; exclude to continue</span> : <Select aria-label={`kind for ${row.title || row.url}`} value={kindFor(row.ordinal) ?? "auto"} disabled={disabled}
              onChange={event => setKinds(previous => { const next = new Map(previous); const value = event.target.value; next.set(row.ordinal, value === "podcast" || value === "article" ? value : null); return next; })}>
              <option value="auto">detect source kind</option><option value="article">articles</option><option value="podcast">podcast</option>
            </Select>}
          </li>)}</ul>
          <CommandRefusal subject={subject} reread={read.refetch} />
        </>}
      <div className={styles.actions}>
        <Button emphasis="strong" disabled={tooLarge || disabled || invalid || selected.length === 0} aria-busy={pending?.phase === "Sending" || undefined} onClick={() => void submit()}>import subscriptions</Button>
        <Button onClick={onClose}>cancel</Button>
      </div>
    </div>
  </Dialog>;
}
