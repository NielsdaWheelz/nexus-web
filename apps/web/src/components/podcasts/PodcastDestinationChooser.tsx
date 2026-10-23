"use client";

/** One destination choice, no writes. Canonical facts gate named rules/imports;
 * sealed discovery targets remain opaque until their existing admission route.
 */
import LibraryChooser, { type ChooserCreation, type ChooserError, type ChooserRow } from "@/components/libraries/LibraryChooser";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import { libraryDestinations } from "@/lib/libraries/api";
import { getDefaultPodcastLibrary, getPodcastDetail, type PodcastTarget } from "@/lib/podcasts/api";
import { podcastErrorMessage } from "@/lib/podcasts/paneState";
import PodcastImportProgress from "./PodcastImportProgress";
import styles from "./PodcastCommands.module.css";

export default function PodcastDestinationChooser({ target, mode, onChoose, create = null, status, creationError = null }: {
  readonly target: PodcastTarget;
  readonly mode: "follow" | "current_episodes";
  readonly onChoose: (libraryId: string, included: boolean) => void;
  readonly create?: ChooserCreation | null;
  readonly status?: string;
  readonly creationError?: ChooserError | null;
}) {
  const stamp = useChangeStamp("Libraries", "Podcasts", "Entries");
  const source = usePaneFreeServerValue({ key: `podcast-destinations:${JSON.stringify([target, mode])}`, stale: stamp,
    load: async signal => {
      const [catalog, detail, personalId] = await Promise.all([
        libraryDestinations(signal),
        target.kind === "Canonical" ? getPodcastDetail(target.podcast_id, signal) : Promise.resolve(null),
        mode === "current_episodes" ? getDefaultPodcastLibrary(signal) : Promise.resolve(null),
      ]);
      return { catalog, detail, personalId };
    },
  });
  if (source.status !== "ready") return <div className={styles.form}>
    {status ? <FeedbackStatus content={{ tone: "Neutral", title: status }} announcement="Polite" /> : null}
    {creationError ? <FeedbackNotice content={creationError.content} announcement="Polite" actions={creationError.retry ? [{ label: "retry library creation", onClick: creationError.retry, busy: creationError.busy, commandKey: creationError.commandKey }] : undefined} /> : null}
    {source.status === "loading" ? <PaneLoadingState label="checking destinations…" announcement="Polite" />
      : <FeedbackNotice content={podcastErrorMessage(source.error, "couldn’t load destinations.")} announcement="Polite" actions={[{ label: "retry loading", onClick: source.refetch }]} />}
  </div>;
  const { catalog, detail, personalId } = source.data;
  const options = [
    ...(personalId === null ? [] : [{ id: personalId, name: libraryDisplayName({ is_default: true, name: "" }) }]),
    ...catalog.destinations,
    ...(mode === "follow" ? detail?.destinations.filter(item => !item.is_default && !catalog.destinations.some(destination => destination.id === item.library_id)).map(item => ({ id: item.library_id, name: item.name })) ?? [] : []),
  ];
  const unfinished = detail?.imports.filter(item => options.some(destination => destination.id === item.library_id) && (item.state === "pending" || item.state === "running" || item.state === "failed")) ?? [];
  const rows: ChooserRow[] = options.map(destination => {
    const followed = detail === null ? false : detail.destinations.some(item => item.library_id === destination.id);
    const importing = unfinished.some(item => item.library_id === destination.id);
    const writable = catalog.destinations.some(item => item.id === destination.id) || destination.id === personalId;
    const reason = source.error !== null || source.refreshing ? "checking destination…"
      : mode === "follow" && followed && !writable ? "a library admin must remove this subscription."
        : importing && !(mode === "follow" && followed) ? "an unfinished import already exists in this library. review its progress." : null;
    return { id: destination.id, name: destination.name,
      confirmed: { included: followed ? 1 : 0, total: 1 },
      intended: { included: 0, total: 1 }, progress: "Settled",
      note: importing ? "unfinished import" : undefined,
      action: reason === null ? { kind: "Set", included: mode === "follow" ? !followed : true, label: mode === "current_episodes" ? "choose destination" : followed ? `review removal from ${destination.name}` : `review subscription in ${destination.name}` } : { kind: "Blocked", reason } };
  });
  return <div className={styles.form}><LibraryChooser context={`podcast:${JSON.stringify([target, mode])}`} membershipKind={mode === "follow" ? "Confirmed" : "Chosen"}
    rows={rows} onToggle={({ id }) => {
      if (source.error !== null || source.refreshing || !rows.some(row => row.id === id && row.action.kind === "Set")) return false;
      onChoose(id, rows.find(row => row.id === id)?.confirmed?.included === 1); return true;
    }} loading={source.refreshing} summary={null} status={status}
    error={source.error === null ? creationError : { content: podcastErrorMessage(source.error, "couldn’t refresh destinations."), retry: source.refetch }}
    create={create === null ? null : { ...create, available: create.available && source.error === null && !source.refreshing }} label={mode === "follow" ? "search or create a library" : undefined} empty="no libraries available" />
    {detail === null ? null : unfinished.map(operation => <PodcastImportProgress key={operation.id} operation={operation} title={detail.podcast.title} following={detail.destinations.some(destination => destination.library_id === operation.library_id)} />)}
  </div>;
}
