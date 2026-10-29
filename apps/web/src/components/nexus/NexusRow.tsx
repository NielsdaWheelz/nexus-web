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
import ExcerptDisclosure from "@/components/resources/ExcerptDisclosure";
import ResourceBody, { ResourceMatchEvidence, separateMatchEvidence } from "@/components/resources/ResourceBody";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import { useResolvedResourceItem } from "@/lib/media/mediaSummary";
import type { ResourceItem } from "@/lib/resources/items";
import { MediaFacts } from "@/components/media/MediaIdentity";
import { workspaceTargetActivationIntent } from "@/lib/ui/targetActivation";
import type { NexusRow } from "@/lib/nexus/model";
import { resourceAction, rowFacts } from "@/lib/nexus/rows";
import { resourceMetadataText } from "@/lib/resources/metadata";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { PANE_TITLES_FAILED, useWorkspacePresentations } from "@/lib/workspace/presentations";
import type { NexusController } from "./useNexusController";
import styles from "./Nexus.module.css";
import collection from "@/components/ui/Collection.module.css";

type MenuProps = Omit<ComponentProps<typeof ActionMenu>, "source">;
type DisclosureControls = Pick<ComponentProps<typeof ExcerptDisclosure>, "triggerAttributes" | "returnFocus">;
type RowActions = Pick<NexusController, "activate" | "closePane" | "destinationHref"> & { mobile: boolean; picker: boolean };

export function NexusRowBody({ row, desktop, disclosure }: { row: NexusRow; desktop: boolean; disclosure?: DisclosureControls }) {
  const Icon = row.icon;
  const Content = desktop ? "div" : "span";
  const facts = rowFacts(row, desktop);
  const excerptId = !desktop ? `mobile-nexus-excerpt-${encodeURIComponent(row.key)}` : undefined;
  return (
    <>
      <span className={`${collection.adornment} ${styles.rowIcon}`} aria-hidden="true">
        <Icon size={18} aria-hidden="true" />
      </span>
      <Content className={`${collection.content} ${styles.rowBody}`}>
        {row.item ? <NexusResourceContent item={row.item} row={row} excerptId={excerptId} desktop={desktop} disclosure={disclosure} /> : <>
          <span className={styles.rowLabel}>{row.label}</span>
          {facts ? <span className={collection.detail}>{facts}</span> : null}
        </>}
        {row.action.kind === "Unavailable" ? <span className={collection.detail}>{row.action.reason}</span> : null}
      </Content>
    </>
  );
}

function NexusResourceContent({ item: supplied, row, excerptId, desktop, disclosure }: { item: ResourceItem; row: NexusRow; excerptId: string | undefined; desktop: boolean; disclosure?: DisclosureControls }) {
  const item = useResolvedResourceItem(supplied);
  const body = item.preview.body;
  const metadata = resourceMetadataText(item, row.matchMethod);
  const evidence = separateMatchEvidence(body, row.match ?? null);
  const summary = body.kind === "media" ? body.media_summary : null;
  if (!desktop) return <>
    <span className={styles.rowLabel}>{body.kind === "media" ? body.media_summary.title : body.kind === "named" ? body.title : item.preview.source?.title ?? row.type ?? "resource"}</span>
    <span className={collection.detail}>{metadata}{summary ? <>{metadata ? " · " : null}<MediaFacts summary={summary} /></> : null}{row.state ? ` · ${row.state.toLowerCase()}` : ""}</span>
  </>;
  return <>
    <div className={styles.rowLabel} id={row.matchingPassage || evidence ? undefined : excerptId}><ResourceBody body={body} match={row.match} /></div>
    <ExcerptDisclosure item={item} {...disclosure} />
    <span className={collection.detail}>{metadata}
      {summary ? <>{metadata ? " · " : null}<MediaFacts summary={summary} /></> : null}
      {row.state ? ` · ${row.state.toLowerCase()}` : null}
    </span>
    {evidence ? <div className={`${collection.detail} ${styles.rowSnippet}`} id={row.matchingPassage ? undefined : excerptId}><ResourceMatchEvidence match={evidence} /></div> : null}
    {row.matchingPassage ? <NexusMatchingPassage passage={row.matchingPassage} excerptId={excerptId} disclosure={disclosure} /> : null}
  </>;
}

function NexusMatchingPassage({ passage, excerptId, disclosure }: { passage: NonNullable<NexusRow["matchingPassage"]>; excerptId: string | undefined; disclosure?: DisclosureControls }) {
  const metadata = resourceMetadataText(passage.item, passage.match_method);
  const evidence = separateMatchEvidence(passage.item.preview.body, passage.match);
  return <div className={styles.rowPassage} id={excerptId}>
    <div className={`${collection.detail} ${styles.rowSnippet}`}><ResourceBody body={passage.item.preview.body} match={passage.match} /></div>
    <ExcerptDisclosure item={passage.item} {...disclosure} />
    {evidence ? <div className={`${collection.detail} ${styles.rowSnippet}`}><ResourceMatchEvidence match={evidence} /></div> : null}
    <span className={collection.detail}>{metadata}</span>
  </div>;
}

/** Mobile evidence is selectable flow content beside its native activation button. */
export function NexusRowEvidence({ row }: { row: NexusRow }) {
  if (!row.item) return null;
  const body = row.item.preview.body;
  const evidence = separateMatchEvidence(body, row.match ?? null);
  if (body.kind === "media" || body.kind === "named") {
    if (!evidence && !row.matchingPassage) return null;
  }
  return <div className={styles.mobileEvidence} id={`mobile-nexus-excerpt-${encodeURIComponent(row.key)}`}>
    {body.kind !== "media" && body.kind !== "named" ? <ResourceBody body={body} match={row.match} /> : null}
    <ExcerptDisclosure item={row.item} />
    {evidence ? <ResourceMatchEvidence match={evidence} /> : null}
    {row.matchingPassage ? <NexusMatchingPassage passage={row.matchingPassage} excerptId={undefined} /> : null}
  </div>;
}

function TargetMenu({ row, menuProps, activate, closePane, destinationHref, mobile, picker }: { row: NexusRow; menuProps: MenuProps } & RowActions) {
  const secondary = row.secondary;
  const ownOptions: ActionDescriptor[] = [];
  if (row.matchingPassage) {
    const action = resourceAction(row.matchingPassage.item);
    const href = action.kind === "Available" && action.target.kind === "Resource" && (action.target.activation.kind === "route" || (!picker && action.target.activation.kind === "external")) ? action.target.activation.href : null;
    if (href) ownOptions.push({ kind: "link", id: "Nexus.OpenMatchingPassage", label: "open matching passage", href, icon: <ACTION_CATALOG.Open.icon size={16} aria-hidden="true" />,
      onActivate: action.kind === "Available" && action.target.kind === "Resource" && action.target.activation.kind === "external" ? undefined : (event) => {
        const intent = workspaceTargetActivationIntent(event);
        if (intent.kind === "Unowned") return "unhandled";
        event.preventDefault();
        if (intent.kind === "Consume") return "consumed";
        const fork = picker || intent.intent === "new_pane";
        const result = activate(action, { disposition: { kind: fork ? "Fork" : "Follow" } });
        return result && result.kind !== "Cancelled" ? fork ? "handled-new-pane" : "handled-default" : "consumed";
      },
    });
    else if (action.kind === "Unavailable") ownOptions.push({ kind: "command", id: "Nexus.OpenMatchingPassage", label: "open matching passage", icon: <ACTION_CATALOG.Open.icon size={16} aria-hidden="true" />,
      disabled: true, disabledReason: action.reason, onSelect: () => undefined,
    });
  }
  if (!picker && secondary?.kind === "TargetMenu") for (const pane of secondary.closePanes)
    ownOptions.push({ kind: "command", id: `Nexus.ClosePane:${pane.id}`, label: pane.label, icon: <X size={16} aria-hidden="true" />, onSelect: () => closePane(pane.id) });
  const href = destinationHref(row);
  const fork: Extract<ActionDescriptor, { kind: "link" }> | null = mobile && !picker && href ? {
    kind: "link", id: "Nexus.OpenInNewPane", label: ACTION_CATALOG.OpenInNewPane.label.toLowerCase(), href,
    icon: <ACTION_CATALOG.OpenInNewPane.icon size={16} aria-hidden="true" />,
    onActivate: (event) => {
      const intent = workspaceTargetActivationIntent(event);
      if (intent.kind === "Unowned") return "unhandled";
      event.preventDefault();
      if (intent.kind === "Consume") return "consumed";
      const result = activate(row.action, { disposition: { kind: "Fork" } }, row);
      return result && result.kind !== "Cancelled" ? "handled-new-pane" : "consumed";
    },
  } : null;
  if (picker && ownOptions.length === 0) return null;
  const resourceRef = !picker && secondary?.kind === "TargetMenu" ? secondary.resourceRef : null;
  return <ContextualActionMenu {...menuProps} title={row.label} subjectKey={`nexus:${row.key}`}
    resourceRef={resourceRef ?? undefined}
    showSourceSubject={row.item !== undefined && row.item.action_ref !== row.item.ref}
    navigation={{ key: JSON.stringify([row.key, row.action, href]), fork }}
    sections={[{ id: "Occurrence", actions: ownOptions }]} />;
}

export function NexusRowMenu({ row, menuProps, ...actions }: { row: NexusRow; menuProps: MenuProps } & RowActions) {
  return row.secondary?.kind === "TargetMenu" || (actions.picker && row.matchingPassage)
    ? <TargetMenu row={row} menuProps={menuProps} {...actions} />
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
