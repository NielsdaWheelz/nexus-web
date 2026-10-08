"use client";

// Evidence, straight from the document map: passage groups in document order,
// the whole-document items as one final group, and the groups whose passage
// cannot be placed under "Needs attention". Following, the list keeps the
// group at the reading position in view and marks those inside the visible
// band; scrolling the list browses. A group's jump is a reader jump.
import { useEffect, useMemo, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import { useResourceOverlaysController } from "@/lib/resources/resourceOverlaysController";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { useReaderState, type Reader } from "@/lib/documentReader/DocumentReader";
import type { AnnotationState } from "../annotations";
import { targetOfGroup } from "../hostedReader";
import EvidenceRow, { type EvidenceActions, type EvidenceItem } from "./EvidenceRow";
import styles from "../media.module.css";

type Group = AnnotationState extends { map: infer M }
  ? M extends { status: "ready"; data: infer D }
    ? D extends { evidence: { passage_groups: (infer G)[] } }
      ? G
      : never
    : never
  : never;
type Filter = "Highlights" | "Citations" | "Links" | "Machine links";

const FILTER_OF: Record<EvidenceItem["kind"], Filter> = {
  Highlight: "Highlights",
  SourceReference: "Citations",
  GeneratedCitation: "Citations",
  Link: "Links",
  MachineLink: "Machine links",
};

export default function EvidencePane({
  resourceRef,
  state,
  reader,
  actions,
  openKey,
  onJump,
  onRetry,
}: {
  readonly resourceRef: string;
  readonly state: AnnotationState;
  readonly reader: Reader;
  readonly actions: EvidenceActions;
  /** An item (or source note) to show: it stops following and scrolls there. */
  readonly openKey: { readonly id: string } | null;
  readonly onJump: (group: Group) => void;
  readonly onRetry: () => void;
}) {
  const { linkComposer } = useResourceOverlaysController();
  const [hidden, setHidden] = useState<ReadonlySet<Filter>>(new Set());
  const [following, setFollowing] = useState(true);
  const [active, setActive] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const linkButton = useRef<HTMLButtonElement>(null);
  const band = useReaderState(reader, (s) => s.viewport && [s.viewport.start, s.viewport.end].join());
  const structure = useReaderState(reader, (s) => (s.document.status === "ready" ? s.document.structure : null));
  const data = state.map.status !== "loading" ? state.map.data : null;
  const evidence = data?.evidence;

  const groups = useMemo(() => {
    const at = (group: Group) => {
      const target = targetOfGroup(group.resolution);
      if (!target || !structure) return null;
      const point =
        target.kind === "range"
          ? ({ kind: "text", unit: target.unit, offset: target.start } as const)
          : target.kind === "quads"
            ? ({ kind: "pdf", page: target.page, y: 0 } as const)
            : target.kind === "point"
              ? target.point
              : null;
      return point ? structure.fraction(point) : 0;
    };
    return (evidence?.passage_groups ?? []).map((group) => ({ group, at: at(group) }));
  }, [evidence, structure]);
  const visible = (items: readonly EvidenceItem[]) => items.filter((item) => !hidden.has(FILTER_OF[item.kind]));

  // Following: the group at the reading position stays in view.
  useEffect(() => {
    if (!following || !band) return;
    const [start, end] = band.split(",").map(Number);
    const current = groups.find(({ at }) => at !== null && at >= start - 0.001) ?? null;
    const element = current && list.current?.querySelector(`[data-group="${CSS.escape(current.group.locus_ref)}"]`);
    if (element instanceof HTMLElement && list.current)
      list.current.scrollTop = element.offsetTop - list.current.offsetTop;
    for (const { group, at } of groups)
      list.current
        ?.querySelector(`[data-group="${CSS.escape(group.locus_ref)}"]`)
        ?.toggleAttribute("data-in-view", at !== null && at >= start && at <= end);
  }, [band, following, groups]);

  // An opened item: browse to its group.
  useEffect(() => {
    if (!openKey) return;
    const group = groups.find(({ group }) =>
      group.items.some((item) => item.id === openKey.id || ("edge_id" in item && item.edge_id === openKey.id) || (item.kind === "SourceReference" && item.stable_key === openKey.id)),
    );
    const documentItem = evidence?.document_items.some((item) => item.id === openKey.id || ("edge_id" in item && item.edge_id === openKey.id));
    if (!group && !documentItem) return;
    const key = group ? group.group.locus_ref : "document";
    setFollowing(false);
    setActive(key);
    setHidden(new Set());
    requestAnimationFrame(() =>
      list.current?.querySelector(`[data-group="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "start" }),
    );
  }, [evidence, groups, openKey]);

  if (state.map.status === "loading") return <p className={styles.status}>Loading reader items…</p>;
  const failure = state.map.status === "failed" ? (
      <FeedbackNotice
        content={{ tone: "Danger", title: "Connections couldn’t be loaded" }}
        announcement="Assertive"
        actions={[{ label: "Retry", onClick: onRetry }]}
      />
    ) : null;
  if (!data) return failure;
  const counts: Record<Filter, number> = {
    Highlights: evidence!.counts.highlights,
    Citations: evidence!.counts.citations,
    Links: evidence!.counts.links,
    "Machine links": evidence!.counts.machine_links,
  };
  const placed = groups.filter(({ group }) => group.resolution.kind === "Resolved");
  const unplaced = groups.filter(({ group }) => group.resolution.kind !== "Resolved");
  const section = (key: string, title: string, label: string | null, items: readonly EvidenceItem[], jump: (() => void) | null) =>
    visible(items).length ? (
      <section key={key} className={styles.group} data-group={key} data-active={active === key || undefined}>
        <header className={styles.groupHead}>
          <span className={styles.kind}>{title}</span>
          {label ? <span className={styles.groupLabel}>{label}</span> : null}
          {jump ? (
            <button
              type="button"
              className={styles.textButton}
              aria-label={`Jump to ${label ?? title}`}
              onClick={() => {
                setActive(key);
                jump();
              }}
            >
              go to passage
            </button>
          ) : null}
        </header>
        {visible(items).map((item) => (
          <EvidenceRow key={item.id} item={item} actions={actions} active={active === key} onConnectionChanged={(row) => {
            if (row?.contains(document.activeElement)) linkButton.current?.focus();
            actions.refresh();
          }} />
        ))}
      </section>
    ) : null;
  const excerpt = (group: Group) =>
    group.target_excerpt.kind === "Present" && group.target_excerpt.value.trim() ? group.target_excerpt.value : null;

  return (
    <div className={styles.evidence}>
      {failure}
      <div className={styles.evidenceHead}>
        <Button ref={linkButton} variant="ghost" size="sm" onClick={() => void linkComposer.openResourceLink(resourceRef)}>Link…</Button>
        <div role="group" aria-label="Filter by type" className={styles.filters}>
          {(Object.keys(counts) as Filter[]).map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={!hidden.has(filter)}
              onClick={() => {
                const next = new Set(hidden);
                if (!next.delete(filter)) next.add(filter);
                setHidden(next);
              }}
            >
              {filter} {counts[filter]}
            </button>
          ))}
        </div>
        <button type="button" className={styles.textButton} onClick={() => setFollowing(!following)}>
          {following ? "all items" : "follow text"}
        </button>
      </div>
      {data!.status === "partial" ? (
        <FeedbackNotice content={{ tone: "Warning", title: "Some reader items are unavailable." }} announcement="Polite" />
      ) : null}
      <div
        ref={list}
        className={styles.evidenceList}
        role="group"
        aria-label="Connections"
        onWheel={() => setFollowing(false)}
        onTouchMove={() => setFollowing(false)}
      >
        {placed.length + unplaced.length + evidence!.document_items.length === 0 ? (
          <p className={styles.status}>No connections in this document yet.</p>
        ) : null}
        {placed.map(({ group }) =>
          section(group.locus_ref, "Passage", excerpt(group), group.items, () => onJump(group)),
        )}
        {section("document", "Whole document", null, evidence!.document_items, null)}
        {unplaced.length ? <h3 className={styles.kind}>Needs attention</h3> : null}
        {unplaced.map(({ group }) =>
          section(group.locus_ref, "Unavailable passage", excerpt(group), group.items, null),
        )}
      </div>
    </div>
  );
}
