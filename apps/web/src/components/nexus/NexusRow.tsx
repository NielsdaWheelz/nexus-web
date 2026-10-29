"use client";

import { X } from "lucide-react";
import { ACTION_CATALOG } from "@/lib/actions/catalog";

// Row parts: resource bodies, menus, and visible search status.
import { checkSession } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import type { ComponentProps } from "react";
import {FeedbackFailure, FeedbackBusy} from "@/components/feedback/Feedback";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import Button from "@/components/ui/Button";
import {apiTransportFeedback} from "@/lib/api/client";
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
import { PANE_TITLES_FAILED, useWorkspacePresentations } from "@/lib/workspace/presentations";
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
    ownOptions.push({ kind: "command", id: "Nexus.OpenMatchingPassage", label: "Open matching passage", icon: <ACTION_CATALOG.Open.icon size={16} aria-hidden="true" />,
      disabled: action.kind === "Unavailable", disabledReason: action.kind === "Unavailable" ? action.reason : undefined,
      onSelect: ({ openIntent }) => activate(action, { disposition: { kind: openIntent === "new_pane" ? "Fork" : "Follow" } }),
    });
  }
  if (secondary?.kind === "ResourceMenu") for (const pane of secondary.closePanes)
    ownOptions.push({ kind: "command", id: `Nexus.ClosePane:${pane.id}`, label: pane.label, icon: <X size={16} aria-hidden="true" />, onSelect: () => closePane(pane.id) });
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

/** Only a resource action is a menu; direct pane close keeps its native button. */
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
  const {text,action} = controller.searchProgress;
  return <>
    <FeedbackBusy subject={controller.searchIdentity} pending={controller.pending}/>
    <AuthoredReadFailure {...controller.localSearchFailure} title="couldn’t search this device"/>
    {[...controller.searchFailures].map(([source,failure]) => {
      const title = admission !== "Ready" ? "search needs a connection" : source === "Reference" ? "couldn’t open this resource"
        : source === "Hybrid" ? "related matches aren’t available" : source === "Direct" ? "couldn’t find this destination" : "couldn’t search your content";
      const blocked = ["E_INVALID_REQUEST","E_NOT_FOUND","E_CONVERSATION_NOT_FOUND"].includes(failure.error.code);
      return <FeedbackFailure key={source} scope="Local" occurrence={failure.occurrence}
        content={apiTransportFeedback(failure.error,title) ?? {tone:"Warning",title,requestId:failure.error.requestId}}
        announcement="Polite" returnFocus={returnFocus}
        actions={blocked ? undefined : [{label: admission !== "Ready" ? "try again" : source === "Hybrid" ? "retry related matches" : source === "Reference" ? "retry lookup" : "retry search",
          onClick: () => {if (admission !== "Ready") void checkSession(); else controller.retry(source);}, busy:controller.retrying.has(source)}]}/>;
    })}
    {text ? <p className={styles.searchStatus}>{text}</p> : null}
    {action === "refresh" ? <Button reserveIcon onClick={() => {controller.refreshResults(); returnFocus()?.focus({preventScroll:true});}}>refresh results</Button> : null}
  </>;
}

export function NexusTitleFailure({returnFocus}: {returnFocus?:()=>HTMLElement|null}) {
  const presentations = useWorkspacePresentations();
  const failure = presentations.titleFailure;
  return failure ? <FeedbackFailure scope="Local" occurrence={failure.occurrence}
    content={apiTransportFeedback(failure.error,PANE_TITLES_FAILED) ?? {tone:"Warning",title:PANE_TITLES_FAILED}} announcement="Polite"
    actions={[{label:"retry",onClick:presentations.retryTitles,busy:failure.pending}]} returnFocus={returnFocus}/> : null;
}
