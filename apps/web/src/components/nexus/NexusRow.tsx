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
import type { LocalMatch } from "@/lib/search/localSearch";
import { SEARCH_ACTION_LABELS } from "@/lib/search/progress";
import ActionMenu from "@/components/ui/ActionMenu";
import ResourceBody, { ResourceMatchEvidence, separateMatchEvidence } from "@/components/resources/ResourceBody";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import type { ResourceItem } from "@/lib/resources/items";
import type { NexusRow } from "@/lib/nexus/model";
import { resourceAction, rowFacts } from "@/lib/nexus/rows";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { PANE_TITLES_FAILED } from "@/lib/workspace/presentations";
import type { NexusController } from "./useNexusController";
import styles from "./Nexus.module.css";
import collection from "@/components/ui/Collection.module.css";

type MenuProps = Omit<ComponentProps<typeof ActionMenu>, "source">;
type RowActions = Pick<NexusController, "activate" | "closePane">;

export function NexusRowBody({ row, desktop }: { row: NexusRow; desktop: boolean }) {
  const Icon = row.icon;
  const facts = rowFacts(row);
  const excerptId = !desktop ? `mobile-nexus-excerpt-${encodeURIComponent(row.key)}` : undefined;
  return (
    <>
      <span className={`${collection.adornment} ${styles.rowIcon}`} aria-hidden="true">
        <Icon size={18} aria-hidden="true" />
      </span>
      <div className={`${collection.content} ${styles.rowBody}`}>
        {row.item ? <NexusResourceContent item={row.item} row={row} excerptId={excerptId} /> : row.localMatch ? <NexusLocalContent match={row.localMatch} title={nexusRowPrimaryText(row)} facts={facts} excerptId={excerptId} /> : <>
          <span className={styles.rowLabel} title={nexusRowPrimaryText(row)}>{row.label}</span>
          {facts ? <span className={collection.detail}>{facts}</span> : null}
        </>}
        {row.action.kind === "Unavailable" ? <span className={collection.detail}>{row.action.reason}</span> : null}
      </div>
    </>
  );
}

function localContent(match: LocalMatch) {
  const excerpt = match.excerpt;
  const evidence: Schema<"SearchMatchOut"> | null = excerpt ? {
    excerpt: { text: excerpt.text, truncated_before: excerpt.before, truncated_after: excerpt.after },
    ranges: excerpt.marks.map(([start, end]) => ({ start: Array.from(excerpt.text.slice(0, start)).length, end: Array.from(excerpt.text.slice(0, end)).length })),
  } : null;
  const body: Schema<"ResourceItemOut">["preview"]["body"] = match.resource.kind === "note"
    ? { kind: "prose", excerpt: evidence?.excerpt ?? { text: match.label, truncated_before: false, truncated_after: false }, format: "plain", image_count: 0, role: null }
    : match.resource.kind === "highlight"
      ? { kind: "passage", exact: { text: match.resource.selection?.quote_exact ?? match.label, truncated_before: false, truncated_after: false }, prefix: null, suffix: null, color: match.resource.color }
      : { kind: "named", title: match.label, contributors: null, image_url: null, media_kind: null };
  const separate = separateMatchEvidence(body, evidence);
  return { body, evidence, separate };
}

/** Names and tooltips describe the literal primary content the row actually paints. */
export function nexusRowPrimaryText(row: NexusRow): string {
  const literal = (excerpt: Schema<"ExcerptOut">) => `${excerpt.truncated_before ? "…" : ""}${excerpt.text}${excerpt.truncated_after ? "…" : ""}`;
  const body = row.localMatch ? localContent(row.localMatch).body : row.item?.preview.body;
  if (!body) return row.label;
  switch (body.kind) {
    case "named": return body.title || "untitled";
    case "prose": return body.excerpt.text ? literal(body.excerpt) : row.label;
    case "passage": return [body.prefix && !body.exact.truncated_before ? literal(body.prefix) : "", literal(body.exact), body.suffix && !body.exact.truncated_after ? literal(body.suffix) : ""].join("") || row.label;
    case "images": return [body.count === 1 ? "image" : `${body.count} images`, ...body.alts.flatMap(alt => alt ? [literal(alt)] : [])].join("\n");
    case "reference": return body.label?.text ? `reference · ${literal(body.label)}` : "embedded resource";
    case "media": return body.media_summary.title;
  }
}

function rowEvidence(body: Schema<"ResourceItemOut">["preview"]["body"], match: Schema<"SearchMatchOut"> | null) {
  if (body.kind === "media" && match?.excerpt.text === body.media_summary.title
    && !match.excerpt.truncated_before && !match.excerpt.truncated_after) return null;
  return separateMatchEvidence(body, match);
}

/** Supplemental evidence excludes a complete literal already spoken as the primary name. */
export function nexusRowEvidenceText(row: NexusRow): string | null {
  if (row.localMatch) return localContent(row.localMatch).separate?.excerpt.text ?? null;
  if (row.matchingPassage) return row.matchingPassage.match?.excerpt.text ?? row.matchingPassage.item.label;
  return row.item ? rowEvidence(row.item.preview.body, row.match ?? null)?.excerpt.text ?? null : null;
}

function NexusLocalContent({ match, title, facts, excerptId }: { match: LocalMatch; title: string; facts: string; excerptId: string | undefined }) {
  const { body, evidence, separate } = localContent(match);
  return <>
    <div className={styles.rowLabel} title={title} id={separate ? undefined : excerptId}><ResourceBody body={body} match={evidence} /></div>
    {facts || separate ? <div className={styles.rowSupplement}>
      {facts ? <span className={styles.rowMetadata} title={facts}>{facts}</span> : null}
      {separate ? <div className={styles.rowSnippet} id={excerptId}><ResourceMatchEvidence match={separate} /></div> : null}
    </div> : null}
  </>;
}

function NexusResourceContent({ item, row, excerptId }: { item: ResourceItem; row: NexusRow; excerptId: string | undefined }) {
  const body = item.preview.body;
  const metadata = rowFacts(row);
  const passage = row.matchingPassage;
  const evidence = passage ? separateMatchEvidence(passage.item.preview.body, passage.match) : rowEvidence(body, row.match ?? null);
  return <>
    <div className={styles.rowLabel} title={nexusRowPrimaryText(row)} id={passage || evidence ? undefined : excerptId}><ResourceBody body={body} match={row.match} /></div>
    {metadata || passage || evidence ? <div className={styles.rowSupplement}>
      {metadata ? <span className={styles.rowMetadata} title={metadata}>{metadata}</span> : null}
      {passage || evidence ? <div className={styles.rowSnippet} id={excerptId}>
        {evidence ? <ResourceMatchEvidence match={evidence} /> : passage ? <ResourceBody body={passage.item.preview.body} match={passage.match} /> : null}
      </div> : null}
    </div> : null}
  </>;
}

function ResourceMenu({ row, menuProps, activate, closePane }: { row: NexusRow; menuProps: MenuProps } & RowActions) {
  const secondary = row.secondary;
  const ownOptions: ActionDescriptor[] = [];
  if (row.matchingPassage) {
    const action = row.action.kind === "Unavailable" ? row.action : resourceAction(row.matchingPassage.item);
    ownOptions.push({ kind: "command", id: "Nexus.OpenMatchingPassage", label: "Open matching passage", icon: <ACTION_CATALOG.Open.icon size={16} aria-hidden="true" />,
      disabled: action.kind === "Unavailable", disabledReason: action.kind === "Unavailable" ? action.reason : undefined,
      onSelect: ({ openIntent }) => activate(action, { disposition: { kind: openIntent === "new_pane" ? "Fork" : "Follow" } }),
    });
  }
  if (secondary?.kind === "ResourceMenu") for (const pane of secondary.closePanes)
    ownOptions.push({ kind: "command", id: `Nexus.ClosePane:${pane.id}`, label: pane.label, icon: <X size={16} aria-hidden="true" />, onSelect: () => closePane(pane.id) });
  const target = row.action.kind === "Available" ? row.action.target : null;
  const activation = row.action.kind === "Unavailable" ? { kind: "none" as const, href: null, resource_ref: row.item?.ref ?? (secondary?.kind === "ResourceMenu" ? secondary.resourceRef : row.key), unavailable_reason: null } : row.item?.activation ?? (target?.kind === "Resource" ? target.activation : {
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
    {controller.recentRead.error !== null ? <FeedbackNotice content={{ tone: "Warning", title: "couldn’t load recent picks" }} announcement="None"
      actions={[{ label: "retry", onClick: controller.recentRead.retry, busy: controller.recentRead.retrying }]} returnFocus={returnFocus} /> : null}
    {controller.titlesFailed ? <FeedbackNotice content={{ tone: "Warning", title: PANE_TITLES_FAILED }} announcement="None"
      actions={[{ label: "retry", onClick: controller.retryTitles }]} returnFocus={returnFocus} /> : null}
  </section>;
}
