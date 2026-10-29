"use client";

import { Info, X } from "lucide-react";
import { ACTION_CATALOG } from "@/lib/actions/catalog";

// Row parts: resource bodies, menus, and visible search status.
import { checkSession } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import type { ComponentProps } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { ControlContents } from "@/components/ui/control";
import type { Schema } from "@/lib/api/wire";
import { excerptTextParts } from "@nexus/authored/excerpt";
import { SEARCH_ACTION_LABELS } from "@/lib/search/progress";
import ActionMenu from "@/components/ui/ActionMenu";
import ExcerptDisclosure from "@/components/resources/ExcerptDisclosure";
import ResourceBody, { ExcerptText, ResourceIndexBody, ResourceMatchEvidence, separateMatchEvidence } from "@/components/resources/ResourceBody";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import type { ResourceItem } from "@/lib/resources/items";
import { workspaceTargetActivationIntent } from "@/lib/ui/targetActivation";
import type { NexusRow } from "@/lib/nexus/model";
import { resourceAction, rowFacts } from "@/lib/nexus/rows";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { PANE_TITLES_FAILED } from "@/lib/workspace/presentations";
import type { NexusController } from "./useNexusController";
import styles from "./Nexus.module.css";
import collection from "@/components/ui/Collection.module.css";

type MenuProps = Omit<ComponentProps<typeof ActionMenu>, "source">;
type RowActions = Pick<NexusController, "activate" | "closePane" | "destinationHref"> & { mobile: boolean; picker: boolean };
type Body = Schema<"ResourceItemOut">["preview"]["body"];

/** A capture's displayed literal: its selected text and selection omission marks. null paints a placeholder. */
function selectedLiteral(body: Extract<Body, { kind: "passage" }>): Schema<"ExcerptOut"> | null {
  if (body.excerpt.kind !== "content") return null;
  const exact = excerptTextParts(body.excerpt.body).exact;
  return exact ? { text: exact, truncated_before: body.excerpt.selected_truncated_before, truncated_after: body.excerpt.selected_truncated_after } : null;
}

/** Compact rows paint a capture's selected literal, with ranges when the match is that literal; the full excerpt is an explicit disclosure. */
function RowContent({ body, match }: { body: Body; match: Schema<"SearchMatchOut"> | null }) {
  if (body.kind !== "passage") return <ResourceBody body={body} match={match} />;
  const literal = selectedLiteral(body);
  return <span data-resource-primary>{literal ? <ExcerptText excerpt={literal} match={match} /> : <ResourceIndexBody body={body} />}</span>;
}

/** Mobile rows are one native button, so only phrasing content belongs here; evidence follows it. */
export function NexusRowBody({ row, desktop }: { row: NexusRow; desktop: boolean }) {
  const Icon = row.icon;
  const Content = desktop ? "div" : "span";
  const facts = rowFacts(row);
  return (
    <>
      <span className={`${collection.adornment} ${styles.rowIcon}`} aria-hidden="true">
        <Icon size={18} aria-hidden="true" />
      </span>
      <Content className={`${collection.content} ${styles.rowBody}`}>
        {row.item && desktop ? <NexusResourceContent item={row.item} row={row} facts={facts} /> : <>
          <span className={styles.rowLabel} title={nexusRowPrimaryText(row)}>{row.item ? <RowContent body={row.item.preview.body} match={row.match ?? null} /> : row.label}</span>
          {facts ? <span className={collection.detail}>{facts}</span> : null}
        </>}
        {row.action.kind === "Unavailable" ? <span className={collection.detail}>{row.action.reason}</span> : null}
      </Content>
    </>
  );
}

/** Names and tooltips describe the literal primary content the row actually paints. */
export function nexusRowPrimaryText(row: NexusRow): string {
  const literal = (excerpt: Schema<"ExcerptOut">) => `${excerpt.truncated_before ? "…" : ""}${excerpt.text}${excerpt.truncated_after ? "…" : ""}`;
  const body = row.item?.preview.body;
  if (!body) return row.label;
  switch (body.kind) {
    case "named": return body.title || "untitled";
    case "prose": return body.excerpt.text ? literal(body.excerpt) : row.label;
    case "passage": return body.excerpt.kind === "content" ? literal({ text: excerptTextParts(body.excerpt.body).exact || "selected region",
      truncated_before: body.excerpt.selected_truncated_before, truncated_after: body.excerpt.selected_truncated_after }) : "table excerpt";
    case "images": return [body.count === 1 ? "image" : `${body.count} images`, ...body.alts.flatMap(alt => alt ? [literal(alt)] : [])].join("\n");
    case "reference": return body.label?.text ? `reference · ${literal(body.label)}` : "embedded resource";
    case "media": return body.media_summary.title;
  }
}

/** Evidence is separate unless it is exactly the literal `RowContent` already paints with its ranges. */
function bodyEvidence(body: Body, match: Schema<"SearchMatchOut"> | null): Schema<"SearchMatchOut"> | null {
  if (body.kind === "media" && match?.excerpt.text === body.media_summary.title
    && !match.excerpt.truncated_before && !match.excerpt.truncated_after) return null;
  if (body.kind === "passage" && match?.excerpt.text && match.excerpt.text === selectedLiteral(body)?.text) return null;
  return separateMatchEvidence(body, match);
}

/** A matching passage replaces the row's own evidence. */
function rowEvidence(row: NexusRow): Schema<"SearchMatchOut"> | null {
  if (row.matchingPassage) return bodyEvidence(row.matchingPassage.item.preview.body, row.matchingPassage.match);
  return row.item ? bodyEvidence(row.item.preview.body, row.match ?? null) : null;
}

/** Supplemental evidence excludes a complete literal already spoken as the primary name. */
export function nexusRowEvidenceText(row: NexusRow): string | null {
  if (row.matchingPassage) return row.matchingPassage.match?.excerpt.text ?? row.matchingPassage.item.label;
  return rowEvidence(row)?.excerpt.text ?? null;
}

function RowEvidence({ row, evidence }: { row: NexusRow; evidence: Schema<"SearchMatchOut"> | null }) {
  return evidence ? <ResourceMatchEvidence match={evidence} />
    : row.matchingPassage ? <RowContent body={row.matchingPassage.item.preview.body} match={row.matchingPassage.match} /> : null;
}

function NexusResourceContent({ item, row, facts }: { item: ResourceItem; row: NexusRow; facts: string }) {
  const evidence = rowEvidence(row);
  return <>
    <div className={styles.rowLabel} title={nexusRowPrimaryText(row)}><RowContent body={item.preview.body} match={row.match ?? null} /></div>
    {facts || row.matchingPassage || evidence ? <div className={styles.rowSupplement}>
      {facts ? <span className={styles.rowMetadata} title={facts}>{facts}</span> : null}
      {row.matchingPassage || evidence ? <div className={styles.rowSnippet}><RowEvidence row={row} evidence={evidence} /></div> : null}
    </div> : null}
  </>;
}

/** The row's capture: its matching passage when one was absorbed, else its own item. */
export function nexusRowExcerptItem(row: NexusRow): ResourceItem | null {
  return row.matchingPassage?.item ?? row.item ?? null;
}

/** The visible copy stays "show excerpt"; its name carries the row's complete primary identity. */
export function nexusRowExcerptName(row: NexusRow): string {
  return `show excerpt for ${nexusRowPrimaryText(row)}`;
}

/** Mobile evidence is selectable flow content after the native activation button and its options. */
export function NexusRowEvidence({ row }: { row: NexusRow }) {
  if (!row.item) return null;
  const evidence = rowEvidence(row);
  return <div className={styles.mobileEvidence}>
    {row.matchingPassage || evidence ? <div className={styles.rowSnippet} id={`mobile-nexus-excerpt-${encodeURIComponent(row.key)}`}><RowEvidence row={row} evidence={evidence} /></div> : null}
    <ExcerptDisclosure item={nexusRowExcerptItem(row)} triggerAttributes={{ "aria-label": nexusRowExcerptName(row) }} />
  </div>;
}

function TargetMenu({ row, menuProps, activate, closePane, destinationHref, mobile, picker }: { row: NexusRow; menuProps: MenuProps } & RowActions) {
  const secondary = row.secondary;
  const ownOptions: ActionDescriptor[] = [];
  if (row.matchingPassage) {
    const action = row.action.kind === "Unavailable" ? row.action : resourceAction(row.matchingPassage.item);
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

/** A reserved query slot points to the full notice without moving focus on arrival. */
export function NexusQueryStatus({ controller, noticeId }: { controller: NexusController; noticeId: string }) {
  return <span className={styles.queryStatus}>
    {controller.noticeText !== null ? <Button iconOnly icon={<Info size={16} aria-hidden />} className={styles.queryStatusButton}
      aria-label={`show notices: ${controller.noticeText}`} aria-busy={controller.busy || undefined}
      onClick={() => {
        const notice = document.getElementById(noticeId);
        notice?.focus({ preventScroll: true });
        notice?.scrollIntoView({ block: "nearest" });
      }} /> : controller.busy ? <span aria-hidden><ControlContents icon={<Info size={16} />} busy /></span> : null}
  </span>;
}

/** All notices follow the candidate grid in its existing scrollport. One screen announces. */
export function NexusNotices({ controller, returnFocus, id }: {
  controller: NexusController; returnFocus: () => HTMLElement | null; id: string;
}) {
  const admission = useRemoteAdmission();
  const { kind, text, action } = controller.searchProgress;
  const { blank, snapshot, readFailure, writeFailure, read } = controller.recentStatus;
  if (controller.noticeText === null) return null;
  return <section id={id} tabIndex={-1} className={styles.notices} aria-label="nexus notices">
    {controller.lookupGuidance !== null ? <p id={`${id}-guidance`} className={styles.empty}>{controller.lookupGuidance}</p> : null}
    {kind === "Notice" ? admission !== "Ready" && (controller.failures.size > 0 || controller.searchUnavailable) ? <FeedbackNotice
      content={{ tone: "Warning", title: "search needs a connection" }} announcement="None"
      actions={[{ label: "try again", onClick: checkSession }]} returnFocus={returnFocus}
    /> : <FeedbackNotice content={{ tone: controller.searchUnavailable ? "Warning" : "Info", title: text }} announcement="None"
      actions={action === null ? undefined : [{ label: SEARCH_ACTION_LABELS[action], onClick: () => {
        if (action === "refresh") controller.refreshResults();
        else if (action === "related") controller.retryRelated();
        else controller.retrySearch();
        returnFocus()?.focus({ preventScroll: true });
      }, busy: controller.retrying.size > 0 }]} /> : null}
    {controller.resultsHeld ? <FeedbackNotice content={{ tone: "Info", title: "search update ready" }} announcement="None"
      actions={[{ label: SEARCH_ACTION_LABELS.refresh, onClick: () => { controller.refreshResults(); returnFocus()?.focus({ preventScroll: true }); } }]} /> : null}
    {blank ? <>
      {readFailure ? <FeedbackNotice content={{ tone: "Warning", title: snapshot ? "couldn’t refresh recent. showing the last loaded list." : "couldn’t load recent." }} announcement="None" actions={[{ label: "retry", onClick: read }]} returnFocus={returnFocus} />
        : snapshot === null ? <FeedbackNotice content={{ tone: "Info", title: "loading recent…" }} announcement="None" />
        : snapshot.entries.length === 0 ? <FeedbackNotice content={{ tone: "Info", title: "resources you open will appear here." }} announcement="None" /> : null}
      {writeFailure ? <FeedbackNotice content={{ tone: "Warning", title: writeFailure === "failed" ? "couldn’t update recent." : "recent update wasn’t confirmed." }} announcement="None" actions={[{ label: "check recent", onClick: read }]} returnFocus={returnFocus} /> : null}
    </> : null}
    {controller.titlesFailed ? <FeedbackNotice content={{ tone: "Warning", title: PANE_TITLES_FAILED }} announcement="None"
      actions={[{ label: "retry", onClick: controller.retryTitles }]} returnFocus={returnFocus} /> : null}
  </section>;
}
