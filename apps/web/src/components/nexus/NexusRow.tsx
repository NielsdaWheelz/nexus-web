"use client";

// What both presenters share about a row: its gutter and two text lines, its spoken name, its verbs,
// and the notices that follow the candidates.
import { X } from "lucide-react";
import { ACTION_CATALOG } from "@/lib/actions/catalog";

// Row parts: resource bodies, menus, and visible search status.
import { Fact, Failed } from "@/components/feedback/Fact";
import { ControlContents } from "@/components/ui/control";
import AsterismMark from "@/components/AsterismMark";
import { Ruling } from "@/components/feedback/Ruling";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import { ExcerptText } from "@/components/resources/ResourceBody";
import { isStaleBuild } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import type { ContextualActionsInput } from "@/lib/actions/useContextualActions";
import type { NexusRow } from "@/lib/nexus/model";
import { rowPrimaryText } from "@/lib/nexus/rowText";
import { NEXUS_COMMANDS } from "@/lib/nexus/query";
import { resourceAction, rowFacts, rowName } from "@/lib/nexus/rows";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import type { ResourceItem } from "@/lib/resources/items";
import { resourceMetadataText } from "@/lib/resources/metadata";
import { SEARCH_ACTION_LABELS } from "@/lib/search/progress";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor, MenuOption } from "@/lib/ui/actionDescriptor";
import { workspaceTargetActivationIntent } from "@/lib/ui/targetActivation";
import type { NexusController } from "./useNexusController";
import styles from "./Nexus.module.css";

type Match = Schema<"SearchMatchOut">;
export type NexusVerb = Extract<ActionDescriptor, { kind: "command" | "link" }>;

/** Passage-bodied items other than highlights are titled by their work and always show their window. */
function isPassage(item: ResourceItem): boolean {
  return item.preview.body.kind === "passage" && parseResourceRef(item.ref)?.scheme !== "highlight";
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

/** A single clamped line begins at its first match; preceding context cannot hide it at large text sizes. */
function windowed(match: Match): Match {
  const first = match.ranges[0];
  if (!first || first.start === 0) return match;
  const points = Array.from(match.excerpt.text);
  const start = first.start;
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
export function NexusRowBody({ row, here, position, query }: { row: NexusRow; here: boolean; position?: number; query: string }) {
  const Icon = row.icon;
  const title = rowPrimaryText(row);
  let inline = titleMatch(row, title);
  // Synchronous pane/recent names have no remote match window; mark their literal name match here.
  const needle = query.trim().toLowerCase();
  const at = needle ? title.toLowerCase().indexOf(needle) : -1;
  if (inline === null && !row.item && at >= 0) {
    const start = Array.from(title.slice(0, at)).length;
    inline = { excerpt: { text: title, truncated_before: false, truncated_after: false },
      ranges: [{ start, end: start + Array.from(title.slice(at, at + needle.length)).length }] };
  }
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
      <span className={styles.title} title={title}>
        {here ? <span className={styles.sub}>here</span> : null}
        <bdi>{inline ? <ExcerptText excerpt={inline.excerpt} match={inline} /> : title}</bdi>
      </span>
      {shown ? <span className={styles.evidence}><ExcerptText excerpt={shown.excerpt} match={shown} /></span>
        : facts || row.reserveDetail ? <span className={styles.facts}>{facts || "\u00a0"}</span> : null}
    </span>
  </>;
}

/** The row's spoken name: `here`, the title, facts, evidence and reason; a lookup command is its title and alias. */
export function nexusRowName(row: NexusRow, here: boolean, alias: string | null): string {
  const title = rowPrimaryText(row);
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
  const paneRef = tab === null ? null : controller.panes.find(pane => pane.id === tab)?.resourceRef ?? null;
  const resourceRef = row.secondary?.kind === "TargetMenu" ? row.secondary.resourceRef : paneRef === null ? null : assumeCanonicalResourceRef(paneRef);
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
  if (row.secondary?.kind === "TargetMenu") for (const pane of row.secondary.closePanes) {
    if (here && resourceRef === null && pane.id === closing) continue;
    occurrence.push({ kind: "command", id: `Nexus.ClosePane:${pane.id}`, label: pane.label, icon: <X size={16} aria-hidden="true" />, onSelect: () => controller.closePane(pane.id) });
  }
  return {
    pair: [...(here ? [] : [verb(false)]), ...(imports ? [] : [verb(true)])],
    close: closing === null ? null : { name: `close ${paneName}`,
      verb: { kind: "command", id: `Nexus.ClosePane:${closing}`, label: "close pane", icon: null, onSelect: () => controller.closePane(closing) } },
    menu: resourceRef === null && occurrence.length === 0 ? null : {
      title: row.label, subjectKey: `nexus:${row.key}`, resourceRef: resourceRef ?? undefined,
      showSourceSubject: row.item !== undefined && row.item.action_ref !== row.item.ref,
      navigation: { key: row.key, fork: null },
      sections: [{ id: "Occurrence", actions: occurrence }],
    },
    read: tab === null && resourceRef !== null,
  };
}

/** The query paints its wait in its existing glyph. */
export function NexusQuerySpinner({ pending }: { pending: boolean }) {
  return <ControlContents icon={<AsterismMark />} busy={pending} />;
}

const SOURCE_NOUNS: Record<string, string> = { Hybrid: "related matches", Reference: "linked items", Direct: "destinations" };

/** The query's own facts, after its candidates: each failed source where its results would be,
 * then what the query and recent say. A refresh failure over shown data says nothing. */
export function NexusNotices({ controller, returnFocus, id }: {
  controller: NexusController; returnFocus: () => HTMLElement | null; id: string;
}) {
  const { kind, text, action } = controller.searchProgress;
  const { blank, snapshot, readFailure, read } = controller.recentStatus;
  const back = () => returnFocus()?.focus({ preventScroll: true });
  return <section id={id} tabIndex={-1} className={styles.notices} aria-label="nexus notices">
    {controller.localSearchFailures.map(({key, ...failure}) => <AuthoredReadFailure key={key} {...failure} title="couldn’t search this device." />)}
    {[...controller.searchFailures].map(([source, failure]) => source === "Reference" && ["E_NOT_FOUND", "E_CONVERSATION_NOT_FOUND"].includes(failure.error.code)
      ? <Fact key={source} line={{ fact: "nothing in nexus matches that link." }} speak />
      : <Failed key={source} error={failure.error} noun={SOURCE_NOUNS[source] ?? "search results"}
        retry={isStaleBuild(failure.error) || failure.error.code === "E_INVALID_REQUEST" ? undefined
          : { run: () => controller.retry(source), busy: controller.retrying.has(source) }} />)}
    {controller.lookupGuidance !== null ? <div id={`${id}-guidance`}><Fact line={{ fact: controller.lookupGuidance }} speak /></div> : null}
    {kind === "Notice" ? <Fact key={text} line={{ fact: text }} speak verbs={action === null ? undefined : [{ label: SEARCH_ACTION_LABELS[action], commandKey: `search ${action}`, busy: controller.retrying.size > 0, run: () => {
      if (action === "related") controller.retryRelated();
      else controller.retrySearch();
      back();
    } }]} /> : null}
    {!blank ? null
      : snapshot === null ? readFailure ? <Fact line={{ fact: "couldn’t load recent items." }} speak verbs={[{ label: "retry", commandKey: "retry recent", run: read }]} /> : <Ruling />
      : snapshot.entries.length === 0 ? <Fact line={{ fact: "items you open will appear here." }} /> : null}
  </section>;
}
