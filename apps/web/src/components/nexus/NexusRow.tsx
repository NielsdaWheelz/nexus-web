"use client";

// Row parts: resource bodies, menus, and visible search status.
import { checkSession } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import type { ComponentProps } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import ResourceBody, { ResourceMatchEvidence, separateMatchEvidence } from "@/components/resources/ResourceBody";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import { useResolvedResourceItem } from "@/lib/media/mediaSummary";
import type { ResourceItem } from "@/lib/resources/items";
import { MediaFacts } from "@/components/media/MediaIdentity";
import type { NexusRow } from "@/lib/nexus/model";
import { resourceAction, rowFacts } from "@/lib/nexus/rows";
import { resourceMetadataText } from "@/lib/resources/metadata";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { NexusController } from "./useNexusController";
import styles from "./Nexus.module.css";
import collection from "@/components/ui/Collection.module.css";

type MenuProps = Omit<ComponentProps<typeof ActionMenu>, "source">;
type RowActions = Pick<NexusController, "activate" | "closePane">;

export function NexusRowBody({ row, desktop }: { row: NexusRow; desktop: boolean }) {
  const Icon = row.icon;
  const facts = rowFacts(row, desktop);
  const excerptId = !desktop ? `mobile-nexus-excerpt-${encodeURIComponent(row.key)}` : undefined;
  return (
    <>
      <span className={`${collection.adornment} ${styles.rowIcon}`} aria-hidden="true">
        <Icon size={18} aria-hidden="true" />
      </span>
      <div className={`${collection.content} ${styles.rowBody}`}>
        {row.item ? <NexusResourceContent item={row.item} row={row} excerptId={excerptId} /> : <>
          <span className={styles.rowLabel}>{row.label}</span>
          {facts ? <span className={collection.detail}>{facts}</span> : null}
        </>}
        {row.action.kind === "Unavailable" ? <span className={collection.detail}>{row.action.reason}</span> : null}
      </div>
    </>
  );
}

function NexusResourceContent({ item: supplied, row, excerptId }: { item: ResourceItem; row: NexusRow; excerptId: string | undefined }) {
  const item = useResolvedResourceItem(supplied);
  const body = item.preview.body;
  const metadata = resourceMetadataText(item, row.matchMethod);
  const evidence = separateMatchEvidence(body, row.match ?? null);
  const summary = body.kind === "media" ? body.media_summary : null;
  return <>
    <div className={styles.rowLabel} id={row.matchingPassage || evidence ? undefined : excerptId}><ResourceBody body={body} match={row.match} /></div>
    <span className={collection.detail}>{metadata}
      {summary ? <>{metadata ? " · " : null}<MediaFacts summary={summary} /></> : null}
      {row.state ? ` · ${row.state.toLowerCase()}` : null}
    </span>
    {evidence ? <div className={`${collection.detail} ${styles.rowSnippet}`} id={row.matchingPassage ? undefined : excerptId}><ResourceMatchEvidence match={evidence} /></div> : null}
    {row.matchingPassage ? <NexusMatchingPassage passage={row.matchingPassage} excerptId={excerptId} /> : null}
  </>;
}

function NexusMatchingPassage({ passage, excerptId }: { passage: NonNullable<NexusRow["matchingPassage"]>; excerptId: string | undefined }) {
  const metadata = resourceMetadataText(passage.item, passage.match_method);
  const evidence = separateMatchEvidence(passage.item.preview.body, passage.match);
  return <div className={styles.rowPassage} id={excerptId}>
    <div className={`${collection.detail} ${styles.rowSnippet}`}><ResourceBody body={passage.item.preview.body} match={passage.match} /></div>
    {evidence ? <div className={`${collection.detail} ${styles.rowSnippet}`}><ResourceMatchEvidence match={evidence} /></div> : null}
    <span className={collection.detail}>{metadata}</span>
  </div>;
}

function ResourceMenu({ row, menuProps, activate, closePane }: { row: NexusRow; menuProps: MenuProps } & RowActions) {
  const secondary = row.secondary;
  const ownOptions: ActionDescriptor[] = [];
  if (row.matchingPassage) {
    const action = resourceAction(row.matchingPassage.item);
    ownOptions.push({ kind: "command", id: "Nexus.OpenMatchingPassage", label: "open matching passage",
      disabled: action.kind === "Unavailable", disabledReason: action.kind === "Unavailable" ? action.reason : undefined,
      onSelect: ({ openIntent }) => activate(action, { disposition: { kind: openIntent === "new_pane" ? "Fork" : "Follow" } }),
    });
  }
  if (secondary?.kind === "ResourceMenu") for (const pane of secondary.closePanes)
    ownOptions.push({ kind: "command", id: `Nexus.CloseTab:${pane.id}`, label: pane.label, onSelect: () => closePane(pane.id) });
  const target = row.action.kind === "Available" ? row.action.target : null;
  const activation = row.item?.activation ?? (target?.kind === "Resource" ? target.activation : {
    kind: target?.kind === "InternalHref" ? "route" as const : "none" as const,
    href: target?.kind === "InternalHref" ? target.href : null,
    resource_ref: secondary?.kind === "ResourceMenu" ? secondary.resourceRef : row.key,
    unavailable_reason: null,
  });
  return <ContextualActionMenu {...menuProps} title={row.label} subjectKey={`nexus:${row.key}`}
    resourceRef={secondary?.kind === "ResourceMenu" ? secondary.resourceRef : undefined}
    showSourceSubject={row.item !== undefined && row.item.action_ref !== row.item.ref}
    displayedActivation={activation} sections={[{ id: "Occurrence", actions: ownOptions }]} />;
}

/** Only a resource action is a menu; direct tab close keeps its native button. */
export function NexusRowMenu({ row, menuProps, ...actions }: { row: NexusRow; menuProps: MenuProps } & RowActions) {
  return row.secondary?.kind === "ResourceMenu"
    ? <ResourceMenu row={row} menuProps={menuProps} {...actions} />
    : null;
}

/** The screen owns its live region; this visible status does not announce twice. */
export function NexusSearchStatus({ controller, returnFocus }: {
  controller: NexusController;
  returnFocus: () => HTMLElement | null;
}) {
  const admission = useRemoteAdmission();
  const { text, action } = controller.searchProgress;
  if (admission !== "Ready" && (controller.failures.size > 0 || controller.searchUnavailable)) return <FeedbackNotice
    content={{ tone: "Warning", title: "search needs a connection" }} announcement="None"
    actions={[{ label: "try again", onClick: checkSession }]} returnFocus={returnFocus}
  />;
  return <div className={styles.searchStatus}>
    {text ? <FeedbackNotice content={{ tone: controller.searchUnavailable ? "Warning" : "Info", title: text }} announcement="None"
      actions={action === null ? undefined : [{
        label: action === "refresh" ? "refresh results" : action === "related" ? "retry related matches" : "retry search",
        onClick: () => {
          if (action === "refresh") controller.refreshResults();
          else if (action === "related") controller.retryRelated();
          else controller.retrySearch();
          returnFocus()?.focus({ preventScroll: true });
        },
        busy: controller.retrying.size > 0,
      }]} /> : null}
  </div>;
}

export function NexusTitleFailure({ failed, retry, returnFocus, announce = true }: { failed: boolean; retry(): void; returnFocus?: () => HTMLElement | null; announce?: boolean }) {
  return failed ? (
    <div className={styles.failures}>
      <FeedbackNotice
        content={{ tone: "Warning", title: "couldn’t refresh tab titles." }}
        announcement={announce ? "Polite" : "None"}
        actions={[{ label: "retry", onClick: retry }]}
        returnFocus={returnFocus}
      />
    </div>
  ) : null;
}
