"use client";

/** One destination choice, no writes. Canonical facts gate named rules/imports;
 * sealed discovery targets remain opaque until their existing admission route.
 */
import LibraryChooser, { type ChooserRow } from "@/components/libraries/LibraryChooser";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import { libraryDestinations } from "@/lib/libraries/api";
import { getDefaultPodcastLibrary, getPodcastDetail, type PodcastTarget } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import PodcastImportProgress from "./PodcastImportProgress";
import styles from "./PodcastCommands.module.css";

export default function PodcastDestinationChooser({ target, onChoose }: {
  readonly target: PodcastTarget;
  readonly onChoose: (libraryId: string) => void;
}) {
  const stamp = useChangeStamp("Libraries", "Podcasts", "Entries");
  const source = usePaneFreeServerValue({ key: `podcast-destinations:${JSON.stringify(target)}`, stale: stamp,
    load: async signal => {
      const [catalog, detail, personalId] = await Promise.all([
        libraryDestinations(signal),
        target.kind === "Canonical" ? getPodcastDetail(target.podcast_id, signal).then(read => read.data) : Promise.resolve(null),
        getDefaultPodcastLibrary(signal),
      ]);
      return { catalog, detail, personalId };
    },
  });
  if (source.status === "loading") return <PaneLoadingState label="checking destinations…" announcement="Polite" />;
  if (source.status === "failed") return <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t load destinations.")} announcement="Polite" actions={[{ label: "retry loading", onClick: source.refetch }]} />;
  const { catalog, detail, personalId } = source.data;
  const options = [
    ...(personalId === null ? [] : [{ id: personalId, name: libraryDisplayName({ is_default: true, name: "" }) }]),
    ...catalog.destinations,
  ];
  const unfinished = detail?.imports.filter(item => options.some(destination => destination.id === item.library_id) && (item.state === "pending" || item.state === "running" || item.state === "failed")) ?? [];
  const rows: ChooserRow[] = options.map(destination => {
    const followed = detail === null ? null : detail.destinations.some(item => item.library_id === destination.id);
    const importing = unfinished.some(item => item.library_id === destination.id);
    const reason = source.error !== null || source.refreshing ? "checking destination…"
      : importing ? "an unfinished import already exists in this library. review its progress." : null;
    return { id: destination.id, name: destination.name,
      confirmed: followed === null ? null : { included: followed ? 1 : 0, total: 1 },
      intended: { included: 0, total: 1 }, progress: "Settled",
      note: importing ? "unfinished import" : undefined,
      action: reason === null ? { kind: "Set", included: true, label: "choose destination" } : { kind: "Blocked", reason } };
  });
  return <div className={styles.form}><LibraryChooser context={`podcast:${JSON.stringify(target)}`} membershipKind="Chosen"
    rows={rows} onToggle={({ id }) => {
      if (source.error !== null || source.refreshing || !rows.some(row => row.id === id && row.action.kind === "Set")) return false;
      onChoose(id); return true;
    }} loading={source.refreshing} summary={null}
    error={source.error === null ? null : { content: podcastErrorMessage(source.error, "couldn’t refresh destinations."), retry: source.refetch }}
    create={null} empty="no libraries available" />
    {detail === null ? null : unfinished.map(operation => <PodcastImportProgress key={operation.id} operation={operation} title={detail.podcast.title} following={detail.destinations.some(destination => destination.library_id === operation.library_id)} />)}
  </div>;
}
