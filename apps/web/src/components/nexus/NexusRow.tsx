"use client";

// Shared row evidence, spoken names, verbs and notices; the phone keeps its two-line body.
import { ACTION_CATALOG } from "@/lib/actions/catalog";

// Row parts: resource bodies, menus, and visible search status.
import { Fact, Failed } from "@/components/feedback/Fact";
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
import type { ActionDescriptor, MenuOption } from "@/lib/ui/actionDescriptor";
import { workspaceTargetActivationIntent } from "@/lib/ui/targetActivation";
import type { NexusController } from "./useNexusController";
import styles from "./Nexus.module.css";

type Match = Schema<"SearchMatchOut">;
type NexusVerb = Extract<ActionDescriptor, { kind: "command" | "link" }>;

/** Passage-bodied items other than highlights are titled by their work and always show their window. */
function isPassage(item: ResourceItem): boolean {
  return item.preview.body.kind === "passage" && parseResourceRef(item.ref)?.scheme !== "highlight";
}

/** A match whose window lies inside the title underlines there and adds no line (the row never repeats its title). */
export function titleMatch(row: NexusRow, title: string, query = ""): Match | null {
  const needle = query.trim().toLowerCase();
  const localAt = needle ? title.toLowerCase().indexOf(needle) : -1;
  if (!row.item && localAt >= 0) {
    const start = Array.from(title.slice(0, localAt)).length;
    return { excerpt: { text: title, truncated_before: false, truncated_after: false },
      ranges: [{ start, end: start + Array.from(title.slice(localAt, localAt + needle.length)).length }] };
  }
  const match = row.match;
  if (!row.item || isPassage(row.item) || !match?.excerpt.text) return null;
  const at = title.indexOf(match.excerpt.text);
  if (at < 0) return null;
  const offset = Array.from(title.slice(0, at)).length;
  return { excerpt: { text: title, truncated_before: false, truncated_after: false },
    ranges: match.ranges.map(range => ({ start: range.start + offset, end: range.end + offset })) };
}

/** The evidence line: an absorbed passage's window, else the row's own window outside its title. */
export function rowEvidence(row: NexusRow, title: string): Match | null {
  const occurrence = row.matchingPassage;
  if (occurrence) return occurrence.match ?? { excerpt: { text: occurrence.item.label, truncated_before: false, truncated_after: false }, ranges: [] };
  if (!row.match?.excerpt.text || titleMatch(row, title)) return null;
  return row.match;
}

/** A single clamped line begins at its first match; preceding context cannot hide it at large text sizes. */
export function windowed(match: Match): Match {
  const first = match.ranges[0];
  if (!first || first.start === 0) return match;
  const points = Array.from(match.excerpt.text);
  const start = first.start;
  return {
    excerpt: { ...match.excerpt, text: points.slice(start).join(""), truncated_before: true },
    ranges: match.ranges.map(range => ({ start: range.start - start, end: range.end - start })),
  };
}

/** Literal matches share an axis. The browser owns first-strong direction, including mixed scripts. */
export function NexusConcordance({ row }: { row: NexusRow }) {
  const source = row.match ?? { excerpt: { text: row.label, truncated_before: false, truncated_after: false }, ranges: [] };
  // One display space per line control keeps both the line and every code-point range intact.
  const match = { ...source, excerpt: { ...source.excerpt, text: source.excerpt.text.replace(/[\t\n\v\f\r\u0085\u2028\u2029]/gu, " ") } };
  const first = match.ranges[0];
  const run = windowed(match);
  if (row.matchMethod === "semantic" || !first) return <span className={styles.concordanceRun} dir="auto"><ExcerptText excerpt={run.excerpt} match={run} /></span>;
  const points = Array.from(match.excerpt.text);
  let start = Math.max(0, first.start - 40);
  // Cut a partial word at the left, preserving the whitespace immediately before the match.
  if (start > 0) while (start < first.start && !/\s/u.test(points[start - 1]!)) start++;
  const after = { excerpt: { ...match.excerpt, text: points.slice(first.start).join(""), truncated_before: false },
    ranges: match.ranges.map(range => ({ start: range.start - first.start, end: range.end - first.start })) };
  return <span className={styles.concordance} dir="auto">
    {/* Direction must come from the whole excerpt, even when its first word was cut from view. */}
    <span className="sr-only" aria-hidden="true">{source.excerpt.text}</span>
    <span className={styles.concordancePlain}><ExcerptText excerpt={run.excerpt} match={run} /></span>
    <span className={styles.concordanceAxis}>
      <span className={styles.concordanceBefore}>{points.slice(start, first.start).join("")}</span>
      <span className={styles.concordanceRun}><ExcerptText excerpt={after.excerpt} match={after} /></span>
    </span>
  </span>;
}

/** In `/` lookup, a command row's first alias, shown and spoken after its title. */
export function nexusRowAlias(row: NexusRow, lookup: boolean): string | null {
  if (!lookup) return null;
  return Object.entries(NEXUS_COMMANDS).find(([id]) => row.key === `QuickAction:${id}`)?.[1].aliases[0] ?? null;
}

/** The gutter's glyph and the text cell: the title, then one supplement. */
export function NexusRowBody({ row, query }: { row: NexusRow; query: string }) {
  const Glyph = row.icon;
  const title = rowPrimaryText(row);
  const inline = titleMatch(row, title, query);
  const evidence = rowEvidence(row, title);
  const reason = row.action.kind === "Unavailable" ? row.action.reason : null;
  // An unavailable row keeps its facts and says why last, instead of any evidence.
  const facts = [rowFacts(row), reason].filter(Boolean).join(" · ");
  const shown = evidence && reason === null ? windowed(evidence) : null;
  return <>
    <span className={styles.gutter} aria-hidden="true">
      <Glyph size="1rem" aria-hidden="true" />
    </span>
    <span className={styles.text}>
      <span className={styles.title} title={title}>
        <bdi>{inline ? <ExcerptText excerpt={inline.excerpt} match={inline} /> : title}</bdi>
      </span>
      {shown ? <span className={styles.evidence}><ExcerptText excerpt={shown.excerpt} match={shown} /></span>
        : facts ? <span className={styles.facts}>{facts}</span> : null}
    </span>
  </>;
}

/** The row's spoken name: `here`, the title, facts, evidence and reason; a lookup command is its title and alias. */
export function nexusRowName(row: NexusRow, here: boolean, alias: string | null): string {
  if (row.name !== undefined) return rowName([row.name, alias, row.action.kind === "Unavailable" ? row.action.reason : null]);
  const title = rowPrimaryText(row);
  if (alias !== null) return rowName([title, alias]);
  return rowName([here ? "here" : null, title, rowFacts(row), rowEvidence(row, title)?.excerpt.text,
    row.matchingPassage ? resourceMetadataText(row.matchingPassage.item, row.matchingPassage.match_method) : null,
    row.action.kind === "Unavailable" ? row.action.reason : null]);
}

interface NexusRowVerbs {
  /** `open` (`run` on commands) and `new pane`, as far as the target takes a disposition. */
  readonly pair: readonly NexusVerb[];
  /** The source of the read verbs and of `more`; null when the row has no menu. */
  readonly menu: ContextualActionsInput | null;
}

/**
 * A row's verbs: the palette's own descriptors (`Nexus.Open`, `Nexus.OpenInNewPane`,
 * `Nexus.OpenMatchingPassage`, `Nexus.ShowExcerpt`) and the input of its existing
 * contextual menu. Continuations have none. Only the pair goes through `activate`, so only
 * the pair learns.
 */
export function nexusRowVerbs(
  row: NexusRow,
  here: boolean,
  controller: Pick<NexusController, "activate" | "destinationHref">,
  showExcerpt: (item: ResourceItem) => void,
): NexusRowVerbs | null {
  if (row.key.startsWith("Continuation:")) return null;
  const href = controller.destinationHref(row);
  const reason = row.action.kind === "Unavailable" ? row.action.reason : null;
  const run = row.key.startsWith("Import:") || /^(QuickAction|Intent):/.test(row.key);
  // Opening the import field ignores disposition; sending links can arm a fresh pane.
  const opensImport = row.key === "QuickAction:Nexus.Quick.Import";
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
  const resourceRef = row.secondary?.kind === "TargetMenu" ? row.secondary.resourceRef : null;
  const occurrence: MenuOption[] = [];
  if (row.matchingPassage) {
    const action = row.action.kind === "Unavailable" ? row.action : resourceAction(row.matchingPassage.item);
    const target = action.kind === "Available" && action.target.kind === "Resource" ? action.target : null;
    const passageHref = target && (target.activation.kind === "route" || target.activation.kind === "external") ? target.activation.href : null;
    const icon = ACTION_CATALOG.Open.icon;
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
  return {
    pair: [...(here ? [] : [verb(false)]), ...(opensImport ? [] : [verb(true)])],
    menu: resourceRef === null && occurrence.length === 0 ? null : {
      title: row.label, subjectKey: `nexus:${row.key}`, resourceRef: resourceRef ?? undefined,
      showSourceSubject: row.item !== undefined && row.item.action_ref !== row.item.ref,
      navigation: { key: row.key, fork: null },
      sections: [{ id: "Occurrence", actions: occurrence }],
    },
  };
}

/** The first typed line stands alone; later lines name their class band. */
export function typedSideHead(row: NexusRow, first: string | null): string {
  return row.key === first ? row.rank.tier === "Latched" ? "usual" : ""
    : { Do: "do", Place: "places", Resource: "resources", Passage: "passages" }[row.class];
}

const SOURCE_NOUNS: Record<string, string> = { Hybrid: "related matches", Reference: "linked items", Direct: "destinations" };

/** The query's own facts, after its candidates: each failed source where its results would be,
 * then what the query and recent say. A refresh failure over shown data says nothing. */
export function NexusNotices({ controller, returnFocus, id, set }: {
  controller: NexusController; returnFocus: () => HTMLElement | null; id: string; set?: "Block" | "Apparatus";
}) {
  const { kind, text, action } = controller.searchProgress;
  const { blank, snapshot, readFailure, read } = controller.recentStatus;
  const back = () => returnFocus()?.focus({ preventScroll: true });
  return <section id={id} tabIndex={-1} className={styles.notices} aria-label="nexus notices">
    {set !== "Apparatus" && controller.localSearchFailures.map(({key, ...failure}) => <AuthoredReadFailure key={key} {...failure} noun="search results" />)}
    {[...controller.searchFailures].filter(([source]) => set === undefined || (set === "Apparatus") === (source === "Lexical" || source === "Hybrid")).map(([source, failure]) => source === "Reference" && failure.error.code === "E_NOT_FOUND"
      ? <Fact key={source} line={{ fact: "nothing in nexus matches that link." }} speak />
      : <Failed key={source} error={failure.error} noun={SOURCE_NOUNS[source] ?? "search results"}
        retry={isStaleBuild(failure.error) || failure.error.code === "E_INVALID_REQUEST" ? undefined
          : { run: () => controller.retry(source), busy: controller.retrying.has(source) }} />)}
    {set !== "Apparatus" && controller.lookupGuidance !== null ? <div id={`${id}-guidance`}><Fact line={{ fact: controller.lookupGuidance }} speak /></div> : null}
    {set === undefined && kind === "Pending" && !controller.groups.some(group => group.id === "Results" && group.rows.length > 0) ? <Ruling /> : null}
    {set !== "Apparatus" && (kind === "Notice" || set === undefined && kind === "Empty") ? <Fact key={text} line={{ fact: text }} speak verbs={action === null ? undefined : [{ label: SEARCH_ACTION_LABELS[action], commandKey: `search ${action}`, busy: controller.retrying.size > 0, run: () => {
      if (action === "related") controller.retryRelated();
      else controller.retrySearch();
      back();
    } }]} /> : null}
    {set === "Apparatus" || !blank ? null
      : snapshot === null ? readFailure ? <Fact line={{ fact: "couldn’t load recent items." }} speak verbs={[{ label: "retry", commandKey: "retry recent", run: read }]} /> : <Ruling />
      : snapshot.entries.length === 0 ? <Fact line={{ fact: "items you open will appear here." }} /> : null}
  </section>;
}
