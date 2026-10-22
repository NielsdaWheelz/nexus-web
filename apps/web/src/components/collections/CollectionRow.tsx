"use client";

import {
  useState,
  useContext,
  type CSSProperties,
  type ReactNode,
} from "react";
import MediaActions from "@/components/media/MediaActions";
import MediaIdentity, { MediaTitle } from "@/components/media/MediaIdentity";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { findPaneCollectionRowFocusTarget } from "@/lib/workspace/paneDom";
import { ContributorCreditList } from "@/components/contributors/ContributorCredits";
import EmphasisSegments from "@/components/ui/EmphasisSegments";
import { ChevronRight } from "lucide-react";
import Pill from "@/components/ui/Pill";
import { ResourceOutlineContext } from "@/components/resources/ResourceOutlineList";
import ResourceDisclosure from "@/components/resources/ResourceDisclosure";
import ResourceRow from "@/components/ui/ResourceRow";
import PodcastRowArtwork from "@/components/podcasts/PodcastRowArtwork";
import ContextualActionMenu, {
  type ContextActionSection,
} from "@/components/resources/ContextualActionMenu";
import type {
  CollectionContext,
  CollectionRowView,
} from "@/lib/collections/types";
import {
  collectionActivityText,
  formatCollectionPublicationDate,
} from "./collectionRowFormatting";
import { assertNever } from "@/lib/assertNever";
import outlineStyles from "@/components/resources/ResourceOutline.module.css";
import styles from "./CollectionRow.module.css";

function renderContext(context: CollectionContext): ReactNode {
  switch (context.kind) {
    case "Snippet":
      return (
        <EmphasisSegments
          segments={context.segments}
          emphasisClassName={styles.mark}
        />
      );
    case "Text":
      return context.text;
    default:
      return assertNever(context, "Unsupported collection context");
  }
}

/** Canonical semantic renderer for every media-like collection row. */
export default function CollectionRow({
  row,
  as = "li",
  panel,
  primaryControl,
  rowActionsAvailable = true,
  viewTransitionName,
}: {
  readonly row: CollectionRowView;
  readonly as?: "li" | "div";
  readonly panel?: ReactNode;
  readonly primaryControl?: ReactNode;
  readonly rowActionsAvailable?: boolean;
  readonly viewTransitionName?: string;
}) {
  const mediaLayout = row.media !== undefined;
  const paneId = usePaneRuntime()?.paneId;
  const outline = useContext(ResourceOutlineContext);
  const [localOpen,setLocalOpen] = useState(false);
  const occurrenceKey=`${outline?.scope ?? "collection"}/${row.id}`;
  const disclosed = outline?.view.folds.get(row.id) ?? localOpen;
  const setDisclosed = (open:boolean) => outline ? outline.toggle(row.id,open) : setLocalOpen(open);

  const title = row.title.segments
    ? (
        <EmphasisSegments
          segments={row.title.segments}
          emphasisClassName={styles.mark}
        />
      )
    : row.title.text;

  const supporting = row.media ? <MediaIdentity subject={row.media.subject} /> : (
    <span className={styles.supportLine}>
      {row.contributors.length ? <ContributorCreditList credits={row.contributors} maxVisible={2} overflowNoun="contributors" /> : null}
      {row.publicationDate !== null && row.contributors.length ? <span className={styles.supportSeparator} aria-hidden="true">·</span> : null}
      {row.publicationDate !== null ? <time className={styles.year} dateTime={row.publicationDate}>{formatCollectionPublicationDate(row.publicationDate)}</time> : null}
      {row.context !== null && (row.contributors.length > 0 || row.publicationDate !== null) ? <span className={styles.supportSeparator} aria-hidden="true">·</span> : null}
      {row.context !== null ? <span className={styles.context}>{renderContext(row.context)}</span> : null}
    </span>
  );
  const evidence =
    mediaLayout && row.context !== null
      ? <span className={styles.context}>{renderContext(row.context)}</span>
      : undefined;

  const activity =
    row.activity !== null && row.activity.kind !== "RemainingTime"
      ? collectionActivityText(row.activity)
      : null;
  const exceptionalStatus =
    row.exceptionalStatus !== null
      ? <Pill tone="danger">Update failed</Pill>
      : undefined;
  const status = exceptionalStatus || activity ? (
    <span className={styles.status}>
      {exceptionalStatus}
      {activity ? (
        <span className={styles.activity}>
          <span aria-hidden="true">{activity.visible}</span>
          <span className="sr-only">{activity.accessible}</span>
        </span>
      ) : null}
    </span>
  ) : undefined;

  const menuLabel = `more actions for ${row.title.text}`;
  const sections: readonly ContextActionSection[] = [
    {
      id: "View",
      actions: rowActionsAvailable && row.insertionSource ? [{kind: "command",id:"Resource.AddItem",label:"add item",onSelect:()=>{setDisclosed(true);}}] : rowActionsAvailable && !row.resourceRef ? (row.flatActions ?? []) : [],
    },
  ];
  const more = rowActionsAvailable &&
    (row.resourceRef || sections.some((section) => section.actions.length > 0)) ? (
    <ContextualActionMenu
      title={row.title.text} subjectKey={occurrenceKey}
      sections={sections}
      resourceRef={row.resourceRef ?? undefined}
      label={menuLabel}
      triggerAttributes={{ "data-row-actions-control": "" }}
    />
  ) : undefined;

  const rootStyle: CSSProperties | undefined = viewTransitionName
    ? { viewTransitionName }
    : undefined;

  return (
    <ResourceRow
      as={as}
      primary={row.insertionSource ? {kind:"static"} : row.primary}
      selected={row.selected}
      rootProps={{
        "aria-current": row.selected ? "true" : undefined,
        "data-collection-row-id": row.id,
        "data-collection-item-kind": row.kind,
        "data-media-identity": mediaLayout ? "true" : undefined,
        style: rootStyle,
      }}
      media={mediaLayout}
      title={row.insertionSource && row.primary.kind === "link" ? (
        <>
          <a href={row.primary.href} data-row-focusable="" data-pane-label-hint={row.title.text} aria-label={`open ${row.title.text}`}>•</a>{" "}
          {row.media ? (
            <a href={row.primary.href} data-row-focusable="" data-pane-label-hint={row.title.text}>
              <MediaTitle subject={row.media.subject} />
            </a>
          ) : title}
        </>
      ) : row.media ? <MediaTitle subject={row.media.subject} /> : title}
      supporting={supporting}
      status={status}
      wrapped={mediaLayout}
      evidence={evidence}
      leadingControl={row.insertionSource ? <button type="button" className={outlineStyles.control} aria-label={`${disclosed ? "hide" : "show"} linked resources for ${row.title.text}`} aria-expanded={disclosed} onClick={() => setDisclosed(!disclosed)}><ChevronRight className={outlineStyles.arrow} data-open={disclosed || undefined} size={14} aria-hidden="true" /></button> : undefined}
      leadingVisual={row.artwork !== undefined ? (
        <PodcastRowArtwork
          key={row.artwork.imageUrl}
          title={row.title.text}
          imageUrl={row.artwork.imageUrl}
        />
      ) : undefined}
      primaryControl={mediaLayout ? undefined : primaryControl}
      actions={
        <>
          {row.media && rowActionsAvailable ? (
            <MediaActions
              subject={row.media.subject}
              knownDescriptor={row.media.knownDescriptor}
              density="Row"
              returnFocus={() => findPaneCollectionRowFocusTarget(paneId, row.id)}
            />
          ) : null}
          {more}
        </>
      }
      expanded={<>{panel}{disclosed && row.insertionSource?.kind === "resource" ? <ResourceDisclosure resourceRef={row.insertionSource.ref} occurrencePrefix={occurrenceKey} /> : null}</>}
    />
  );
}
