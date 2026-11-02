"use client";

// What both presenters share about a row: its gutter and two text lines, its spoken name, its verbs,
// and the notices that follow the candidates.
import { X } from "lucide-react";
import { ACTION_CATALOG } from "@/lib/actions/catalog";
import { checkSession } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { FeedbackFailure, FeedbackBusy, FeedbackNotice } from "@/components/feedback/Feedback";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import { ExcerptText } from "@/components/resources/ResourceBody";
import { apiTransportFeedback, isStaleBuild } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import { excerptTextParts } from "@nexus/authored/excerpt";
import type { ContextualActionsInput } from "@/lib/actions/useContextualActions";
import type { NexusRow } from "@/lib/nexus/model";
import { NEXUS_COMMANDS } from "@/lib/nexus/query";
import { resourceAction, rowFacts, rowName } from "@/lib/nexus/rows";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import type { ResourceItem } from "@/lib/resources/items";
import { resourceMetadataText } from "@/lib/resources/metadata";
import { SEARCH_ACTION_LABELS } from "@/lib/search/progress";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor, MenuOption } from "@/lib/ui/actionDescriptor";
import { workspaceTargetActivationIntent } from "@/lib/ui/targetActivation";
import { PANE_TITLES_FAILED, useWorkspacePresentations } from "@/lib/workspace/presentations";
import type { NexusController } from "./useNexusController";
import styles from "./Nexus.module.css";

type Match = Schema<"SearchMatchOut">;
export type NexusVerb = Extract<ActionDescriptor, { kind: "command" | "link" }>;
/** Codepoints of context the evidence line keeps before its first matched range. */
const EVIDENCE_LEAD = 24;

/** Passage-bodied items other than highlights are titled by their work and always show their window. */
function isPassage(item: ResourceItem): boolean {
  return item.preview.body.kind === "passage" && parseResourceRef(item.ref)?.scheme !== "highlight";
}

/** The row's title: a highlight's literal in quotes, a passage's work, a note's first line, else its name. */
export function nexusRowPrimaryText(row: NexusRow): string {
  const literal = (excerpt: Schema<"ExcerptOut">) => `${excerpt.truncated_before ? "…" : ""}${excerpt.text}${excerpt.truncated_after ? "…" : ""}`;
  const item = row.item;
  if (!item) return row.label;
  const body = item.preview.body;
  switch (body.kind) {
    case "named": return body.title || "untitled";
    case "prose": return parseResourceRef(item.ref)?.scheme === "note_block" || !body.excerpt.text ? row.label : literal(body.excerpt);
    case "passage":
      if (isPassage(item)) return item.preview.source?.title?.trim() || "source";
      return `“${body.excerpt.kind === "content" ? literal({ text: excerptTextParts(body.excerpt.body).exact || "selected region",
        truncated_before: body.excerpt.selected_truncated_before, truncated_after: body.excerpt.selected_truncated_after }) : "table excerpt"}”`;
    case "images": return [body.count === 1 ? "image" : `${body.count} images`, ...body.alts.flatMap(alt => alt ? [literal(alt)] : [])].join("\n");
    case "reference": return body.label?.text ? `reference · ${literal(body.label)}` : "embedded resource";
    case "media": return body.media_summary.title;
  }
}

/** A match whose window lies inside the title underlines there and adds no line (the row never repeats its title). */
function titleMatch(row: NexusRow, title: string): Match | null {
  const match = row.match;
  if (!row.item || isPassage(row.item) || !match?.excerpt.text) return null;
  const at = title.indexOf(match.excerpt.text);
  if (at < 0) return null;
  const offset = Array.from(title.slice(0, at)).length;
  return { excerpt: { text: title, truncated_before: false, truncated_after: false },
    ranges: match.ranges.map(range => ({ start: range.start + offset, end: range.end + offset })) };
}

/** The evidence line: an absorbed passage's window, else the row's own window outside its title. */
function rowEvidence(row: NexusRow, title: string): Match | null {
  const occurrence = row.matchingPassage;
  if (occurrence) return occurrence.match ?? { excerpt: { text: occurrence.item.label, truncated_before: false, truncated_after: false }, ranges: [] };
  if (!row.match?.excerpt.text || titleMatch(row, title)) return null;
  return row.match;
}

/** One line shows only its start: open the window a few words before the first range so the matched words paint. */
function windowed(match: Match): Match {
  const first = match.ranges[0];
  if (!first || first.start <= EVIDENCE_LEAD) return match;
  const points = Array.from(match.excerpt.text);
  const space = points.indexOf(" ", first.start - EVIDENCE_LEAD);
  const start = space >= 0 && space < first.start ? space + 1 : first.start - EVIDENCE_LEAD;
  return {
    excerpt: { ...match.excerpt, text: points.slice(start).join(""), truncated_before: true },
    ranges: match.ranges.map(range => ({ start: range.start - start, end: range.end - start })),
  };
}

/** In `/` lookup, a command row's first alias, shown and spoken after its title. */
export function nexusRowAlias(row: NexusRow, lookup: boolean): string | null {
  if (!lookup) return null;
  return Object.entries(NEXUS_COMMANDS).find(([id]) => row.key === `QuickAction:${id}`)?.[1].aliases[0] ?? null;
}

/** The gutter's glyph (or a reorder position) and the text cell: the title, then one supplement. */
export function NexusRowBody({ row, here, position }: { row: NexusRow; here: boolean; position?: number }) {
  const Icon = row.icon;
  const title = nexusRowPrimaryText(row);
  const inline = titleMatch(row, title);
  const evidence = rowEvidence(row, title);
  const reason = row.action.kind === "Unavailable" ? row.action.reason : null;
  // An unavailable row keeps its facts and says why last, instead of any evidence.
  const facts = [rowFacts(row), reason].filter(Boolean).join(" · ");
  const shown = evidence && reason === null ? windowed(evidence) : null;
  return <>
    <span className={styles.gutter} aria-hidden="true">
      {position === undefined ? <Icon size={16} aria-hidden="true" /> : <span className={styles.panePosition}>{position}</span>}
    </span>
    <span className={styles.text}>
      <span className={styles.title} dir="auto" title={title}>
        {here ? <span className={styles.sub}>here</span> : null}
        {inline ? <ExcerptText excerpt={inline.excerpt} match={inline} /> : title}
      </span>
      {shown ? <span className={styles.evidence}><ExcerptText excerpt={shown.excerpt} match={shown} /></span>
        : facts ? <span className={styles.facts}>{facts}</span> : null}
    </span>
  </>;
}

/** The row's spoken name: `here`, the title, facts, evidence and reason; a lookup command is its title and alias. */
export function nexusRowName(row: NexusRow, here: boolean, alias: string | null): string {
  const title = nexusRowPrimaryText(row);
  if (alias !== null) return rowName([title, alias]);
  return rowName([here ? "here" : null, title, rowFacts(row), rowEvidence(row, title)?.excerpt.text,
    row.matchingPassage ? resourceMetadataText(row.matchingPassage.item, row.matchingPassage.match_method) : null,
    row.action.kind === "Unavailable" ? row.action.reason : null]);
}

export interface NexusRowVerbs {
  /** `open` (`run` on commands) and `new pane`, as far as the target takes a disposition. */
  readonly pair: readonly NexusVerb[];
  /** `close pane` on `here` and tab rows, after the read verbs, named for its pane. */
  readonly close: { readonly verb: NexusVerb; readonly name: string } | null;
  /** The source of the read verbs and of `more`; null when the row has no menu. */
  readonly menu: ContextualActionsInput | null;
  /** Opening the rail prepares the menu's read; a tab's rail never reads. */
  readonly read: boolean;
}

/**
 * A row's verbs: the palette's own descriptors (`Nexus.Open`, `Nexus.OpenInNewPane`,
 * `Nexus.OpenMatchingPassage`, `Nexus.ShowExcerpt`, `Nexus.ClosePane:*`) and the input of its existing
 * contextual menu. Continuations and `resume` have none. Only the pair goes through `activate`, so only
 * the pair learns.
 */
export function nexusRowVerbs(
  row: NexusRow,
  here: boolean,
  controller: Pick<NexusController, "activate" | "closePane" | "destinationHref" | "panes">,
  paneName: string,
  showExcerpt: (item: ResourceItem) => void,
): NexusRowVerbs | null {
  if (row.key.startsWith("Continuation:") || row.key === "Resource:Playback:Current") return null;
  const href = controller.destinationHref(row);
  const reason = row.action.kind === "Unavailable" ? row.action.reason : null;
  const run = /^(QuickAction|ImportUrl|Intent):/.test(row.key);
  // Add ignores disposition, so import has no `new pane`.
  const imports = row.key === "QuickAction:Nexus.Quick.Import" || row.key.startsWith("ImportUrl:");
  const verb = (fork: boolean): NexusVerb => {
    const id = fork ? "Nexus.OpenInNewPane" : "Nexus.Open";
    const label = fork ? "new pane" : run ? "run" : "open";
    const activation = (newPane: boolean) => ({ disposition: { kind: fork || newPane ? "Fork" as const : "Follow" as const } });
    if (reason !== null) return { kind: "command", id, label, icon: null, disabled: true, disabledReason: reason, onSelect: () => undefined };
    if (href === null) return { kind: "command", id, label, icon: null, onSelect: detail => { controller.activate(row.action, activation(detail.openIntent === "new_pane"), row); } };
    return { kind: "link", id, label, href, icon: null, onActivate: event => {
      const intent = workspaceTargetActivationIntent(event);
      if (intent.kind === "Unowned") return "unhandled";
      event.preventDefault();
      if (intent.kind === "Consume") return "consumed";
      const result = controller.activate(row.action, activation(intent.intent === "new_pane"), row);
      return result && result.kind !== "Cancelled" ? fork || intent.intent === "new_pane" ? "handled-new-pane" : "handled-default" : "consumed";
    } };
  };
  const tab = row.secondary?.kind === "ClosePane" ? row.secondary.paneId : null;
  const closing = tab ?? (here ? controller.panes.find(pane => pane.current)?.id ?? null : null);
  const occurrence: MenuOption[] = [];
  if (row.matchingPassage) {
    const action = row.action.kind === "Unavailable" ? row.action : resourceAction(row.matchingPassage.item);
    const target = action.kind === "Available" && action.target.kind === "Resource" ? action.target : null;
    const passageHref = target && (target.activation.kind === "route" || target.activation.kind === "external") ? target.activation.href : null;
    const icon = <ACTION_CATALOG.Open.icon size={16} aria-hidden="true" />;
    if (passageHref && target) occurrence.push({ kind: "link", id: "Nexus.OpenMatchingPassage", label: "open matching passage", href: passageHref, icon,
      onActivate: target.activation.kind === "external" ? undefined : (event) => {
        const intent = workspaceTargetActivationIntent(event);
        if (intent.kind === "Unowned") return "unhandled";
        event.preventDefault();
        if (intent.kind === "Consume") return "consumed";
        const result = controller.activate(action, { disposition: { kind: intent.intent === "new_pane" ? "Fork" : "Follow" } });
        return result && result.kind !== "Cancelled" ? intent.intent === "new_pane" ? "handled-new-pane" : "handled-default" : "consumed";
      },
    });
    else if (action.kind === "Unavailable") occurrence.push({ kind: "command", id: "Nexus.OpenMatchingPassage", label: "open matching passage", icon,
      disabled: true, disabledReason: action.reason, onSelect: () => undefined });
  }
  const capture = row.matchingPassage?.item ?? row.item;
  if (capture?.preview.body.kind === "passage" && capture.preview.body.capture_revision !== null)
    occurrence.push({ kind: "command", id: "Nexus.ShowExcerpt", label: "show excerpt", icon: null, hasPopup: "dialog", restoreFocusOnClose: false, onSelect: () => showExcerpt(capture) });
  if (row.secondary?.kind === "TargetMenu") for (const pane of row.secondary.closePanes) if (pane.id !== closing)
    occurrence.push({ kind: "command", id: `Nexus.ClosePane:${pane.id}`, label: pane.label, icon: <X size={16} aria-hidden="true" />, onSelect: () => controller.closePane(pane.id) });
  const paneRef = tab === null ? null : controller.panes.find(pane => pane.id === tab)?.resourceRef ?? null;
  const resourceRef = row.secondary?.kind === "TargetMenu" ? row.secondary.resourceRef : paneRef === null ? null : assumeCanonicalResourceRef(paneRef);
  return {
    pair: [...(here ? [] : [verb(false)]), ...(imports ? [] : [verb(true)])],
    close: closing === null ? null : { name: `close ${paneName}`,
      verb: { kind: "command", id: `Nexus.ClosePane:${closing}`, label: "close pane", icon: null, onSelect: () => controller.closePane(closing) } },
    menu: resourceRef === null && occurrence.length === 0 ? null : {
      title: row.label, subjectKey: `nexus:${row.key}`, resourceRef: resourceRef ?? undefined,
      showSourceSubject: row.item !== undefined && row.item.action_ref !== row.item.ref,
      navigation: { key: JSON.stringify([row.key, row.action, href]), fork: null },
      sections: [{ id: "Occurrence", actions: occurrence }],
    },
    read: tab === null && resourceRef !== null,
  };
}

function NexusTitleFailure({returnFocus}: {returnFocus?:()=>HTMLElement|null}) {
  const presentations = useWorkspacePresentations();
  const failure = presentations.titleFailure;
  return failure ? <FeedbackFailure scope="Local" occurrence={failure.occurrence}
    content={apiTransportFeedback(failure.error,PANE_TITLES_FAILED) ?? {tone:"Warning",title:PANE_TITLES_FAILED}} announcement="Polite"
    actions={isStaleBuild(failure.error) ? undefined : [{label:"retry",onClick:presentations.retryTitles,busy:failure.pending}]} returnFocus={returnFocus}/> : null;
}

/** Domain notices follow candidates; operational failures use the same host's recovery. */
export function NexusNotices({ controller, returnFocus, id }: {
  controller: NexusController; returnFocus: () => HTMLElement | null; id: string;
}) {
  const admission = useRemoteAdmission();
  const { kind, text, action } = controller.searchProgress;
  const { blank, snapshot, readFailure, writeFailure, read } = controller.recentStatus;
  // Zero principals say so on `search all results`; the palette paints no empty notice.
  const notice = kind === "Notice" && text !== "no results found.";
  return <>
    <FeedbackBusy subject={controller.searchIdentity} pending={controller.pending} />
    {controller.localSearchFailures.map(({key, ...failure}) => <AuthoredReadFailure key={key} {...failure} title="couldn’t search this device" />)}
    {[...controller.searchFailures].map(([source, failure]) => {
      const title = admission !== "Ready" ? "search needs a connection" : source === "Reference" ? "couldn’t open this resource"
        : source === "Hybrid" ? "related matches aren’t available" : source === "Direct" ? "couldn’t find this destination" : "couldn’t search your content";
      const blocked = isStaleBuild(failure.error) || ["E_INVALID_REQUEST", "E_NOT_FOUND", "E_CONVERSATION_NOT_FOUND"].includes(failure.error.code);
      return <FeedbackFailure key={source} scope="Local" occurrence={failure.occurrence} announcementOccurrence={failure.error}
        content={apiTransportFeedback(failure.error, title) ?? {tone: "Warning", title, requestId: failure.error.requestId}}
        announcement="Polite" returnFocus={returnFocus}
        actions={blocked ? undefined : [{label: admission !== "Ready" ? "try again" : source === "Hybrid" ? "retry related matches" : source === "Reference" ? "retry lookup" : "retry search",
          onClick: () => { if (admission !== "Ready") void checkSession(); else controller.retry(source); }, busy: controller.retrying.has(source)}]} />;
    })}
    <NexusTitleFailure returnFocus={returnFocus} />
    {controller.noticeText !== null && (controller.lookupGuidance !== null || notice || blank) ? <section id={id} tabIndex={-1} className={styles.notices} aria-label="nexus notices">
      {controller.lookupGuidance !== null ? <p id={`${id}-guidance`} className={styles.empty}>{controller.lookupGuidance}</p> : null}
      {notice ? <FeedbackNotice content={{tone: controller.searchUnavailable ? "Warning" : "Info", title: text}} announcement="None"
        actions={action === null ? undefined : [{label: SEARCH_ACTION_LABELS[action], onClick: () => {
          if (action === "related") controller.retryRelated();
          else controller.retrySearch();
          returnFocus()?.focus({preventScroll: true});
        }, busy: controller.retrying.size > 0}]} /> : null}
      {blank ? <>
        {readFailure ? <FeedbackNotice content={{ tone: "Warning", title: snapshot ? "couldn’t refresh recent. showing the last loaded list." : "couldn’t load recent." }} announcement="None" actions={[{ label: "retry", onClick: read }]} returnFocus={returnFocus} />
          : snapshot === null ? <FeedbackNotice content={{ tone: "Info", title: "loading recent…" }} announcement="None" />
          : snapshot.entries.length === 0 ? <FeedbackNotice content={{ tone: "Info", title: "resources you open will appear here." }} announcement="None" /> : null}
        {writeFailure ? <FeedbackNotice content={{ tone: "Warning", title: writeFailure === "failed" ? "couldn’t update recent." : "recent update wasn’t confirmed." }} announcement="None" actions={[{ label: "check recent", onClick: read }]} returnFocus={returnFocus} /> : null}
      </> : null}
    </section> : null}
  </>;
}
