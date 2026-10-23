"use client";

// Row parts: the body, resource menu, and source failures.
import { checkSession } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import type { ComponentProps } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import ActionMenu from "@/components/ui/ActionMenu";
import ResourceBody, { ResourceMatchEvidence } from "@/components/resources/ResourceBody";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import { useResolvedResourceItem } from "@/lib/media/mediaSummary";
import type { ResourceItem } from "@/lib/resources/items";
import { MediaFacts } from "@/components/media/MediaIdentity";
import type { NexusRow, NexusSource } from "@/lib/nexus/model";
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
  const named = body.kind === "named" || body.kind === "media";
  const title = body.kind === "media" ? body.media_summary.title : body.kind === "named" ? body.title : null;
  const evidence = named && row.match && row.match.excerpt.text !== title ? row.match : null;
  const summary = body.kind === "media" ? body.media_summary : null;
  return <>
    <div className={styles.rowLabel} id={named ? undefined : excerptId}><ResourceBody body={body} match={row.match} /></div>
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
  return <div className={styles.rowPassage} id={excerptId}>
    <div className={`${collection.detail} ${styles.rowSnippet}`}><ResourceBody body={passage.item.preview.body} match={passage.match} /></div>
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

export const NEXUS_SOURCE_FAILURES: Record<NexusSource, string> = {
  Direct: "resources couldn’t be searched", Content: "couldn't search inside sources", Reference: "resource lookup failed",
};

export function NexusSourceFailures({ failures, semanticUnavailable, searchUnavailable, retry, retrying, returnFocus, announce = true }: {
  failures: ReadonlySet<NexusSource>;
  semanticUnavailable: boolean;
  searchUnavailable: boolean;
  retry(source: NexusSource): void;
  retrying: ReadonlySet<NexusSource>;
  returnFocus: () => HTMLElement | null;
  announce?: boolean;
}) {
  const admission = useRemoteAdmission();
  if (failures.size === 0 && !semanticUnavailable && !searchUnavailable) return null;
  if (admission !== "Ready") return <FeedbackNotice
    content={{ tone: "Warning", title: "search needs a connection" }}
    announcement={announce ? "Polite" : "None"}
    actions={[{ label: "try again", onClick: checkSession }]}
    returnFocus={returnFocus}
  />;
  return (
    <div className={styles.failures}>
      {[...failures].map((source) => (
        <FeedbackNotice
          key={source}
          content={{ tone: "Warning", title: NEXUS_SOURCE_FAILURES[source] }}
          announcement={announce ? "Polite" : "None"}
          actions={[{ label: "retry", onClick: () => retry(source), busy: retrying.has(source) }]}
          returnFocus={returnFocus}
        />
      ))}
      {searchUnavailable ? <FeedbackNotice
        content={{ tone: "Warning", title: "search is unavailable for this input", message: "shorten the search or ask nexus with the full text." }}
        announcement={announce ? "Polite" : "None"}
      /> : null}
      {semanticUnavailable ? <FeedbackNotice
        content={{ tone: "Warning", title: "related matches are unavailable; showing text matches" }}
        announcement={announce ? "Polite" : "None"}
      /> : null}
    </div>
  );
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
