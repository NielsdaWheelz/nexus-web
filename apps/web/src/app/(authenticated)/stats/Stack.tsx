"use client";

import { useLayoutEffect, useRef, useState } from "react";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import PaneSection from "@/components/ui/PaneSection";
import { MediaTitle } from "@/components/media/MediaIdentity";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import { apiFetch } from "@/lib/api/client";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { assertNever } from "@/lib/assertNever";
import { pluralize } from "@/lib/text/pluralize";
import { selectMediaAuthors, creditName } from "@/lib/contributors/credits";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import type { MediaSummary } from "@/lib/media/mediaSummary";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import RecordCopyButton from "@/lib/consumption/RecordCopyButton";
import { recordDate, recordDateClause, recordTime, workRecordText, stackRecordText } from "@/lib/consumption/recordText";
import Landscape from "./Landscape";
import Slip, { Stamp } from "./Slip";
import { fnv1a } from "./material";
import styles from "./Stack.module.css";

type Record = Schema<"RecordOut">;
type Work = Schema<"WorkRecordOut">;
type StackYear = Schema<"StackYearOut">;
const WORK = definePaneVisitDataKey<Visit<Work>>("Stats.Work");
const MILESTONES = [
  [19, "a deck of cards"], [65, "a brick"], [180, "a paperback, standing"], [220, "the codex gigas, shut"],
  [300, "a wine bottle"], [381, "a bowling pin"], [600, "a violin"], [910, "a kitchen counter"], [2030, "a door"],
] as const;
const cm = (mm: number) => `${(mm / 10).toFixed(1)} cm`;

function cloth(media: MediaSummary) {
  const paper = media.media_kind === "pdf" || media.media_kind === "web_article";
  const colour = 1 + fnv1a(media.media_id) % 8;
  return { backgroundColor: `var(--cloth-${paper ? "paper" : colour})`, color: paper ? "var(--cloth-paper-ink)" : `var(--cloth-ink-${colour})` };
}

function byline(media: MediaSummary): string {
  return selectMediaAuthors(media.contributors).flatMap(credit => creditName(credit)?.label ?? []).join(", ");
}

function BookInHand({ work, media, compact }: { work: Work; media: MediaSummary; compact: boolean }) {
  const position = work.position;
  const current = position === null ? undefined : work.units.findLast(unit => unit.start <= position);
  const last = current !== undefined && current === work.units[work.units.length - 1];
  const next = current === undefined ? undefined : work.units[work.units.indexOf(current) + 1];
  const closes = current?.part !== null && current?.part !== undefined && next?.part !== current.part
    ? work.parts[current.part] : null;
  const minutes = current !== undefined && position !== null && work.full_read_ms !== null
    ? Math.max(1, Math.ceil((current.end - position) * work.full_read_ms / 60_000)) : null;
  return <section className={styles.inHand} aria-label="book in hand">
    <header className={styles.inHandHead}>
      <div><h2 className={styles.title}><MediaTitle subject={{ kind: "Stored", summary: media }} className={styles.titleText} /></h2>
        {byline(media) ? <p className={styles.byline}>{byline(media)}</p> : null}</div>
      {media.media_kind === "video" ? <p className={styles.byline}>watched {recordTime(work.active_ms)}</p>
        : position !== null ? <p className={styles.place}><strong>{Math.round(position * 100)}%</strong>
          {work.full_read_ms !== null ? <span>{recordTime((1 - position) * work.full_read_ms)} to the end</span> : null}</p> : null}
    </header>
    <Landscape work={work} title={media.title} compact={compact} />
    <div className={styles.resume}>
      <ButtonLink href={`/media/${media.media_id}`} emphasis="strong">Resume</ButtonLink>
      {minutes !== null ? <p>{minutes} min {last ? "to the last page" : `to the end of ${current?.label ?? "the opening"}${closes !== null ? `, which closes ${closes}` : ""}`}</p> : null}
    </div>
  </section>;
}

function WorkRecord({ mediaId, stale, compact, onClose }: {
  mediaId: string;
  stale: string;
  compact: boolean;
  onClose: () => void;
}) {
  const read = useServerValue({ key: `/consumption/works/${mediaId}`, stale, visit: WORK,
    load: async signal => (await apiFetch<ApiJson<"/consumption/works/{media_id}", "get">>(`/api/consumption/works/${mediaId}`, { signal })).data });
  const summaries = useMediaSummaries(read.status === "ready" ? [read.data.media] : []);
  if (read.status === "loading") return <Ruling />;
  if (read.status === "failed") return <Failed error={read.error} noun="record" retry={{ run: () => void read.refetch(), busy: read.retrying }} />;
  const work = read.data, media = summaries.resolve(work.media);
  if (media === null) return null;
  return <section className={styles.workRecord} aria-label={`record of ${media.title}`}>
    <header className={styles.workHead}><h3 className={styles.recordTitle}>{media.title}</h3><Button onClick={onClose}>Put it back</Button></header>
    <Landscape work={work} title={media.title} compact={compact} strip finished={work.finished_on !== null} />
    {work.sittings > 0 && work.first_read_on !== null ? <p className={styles.workFacts}>
      {pluralize(work.sittings, "sitting")}, {work.finished_on !== null ? recordDateClause(work.first_read_on, work.finished_on, "to") : recordDate(work.first_read_on)}. {recordTime(work.active_ms)} on {pluralize(work.days.filter(day => day.active_ms > 0).length, "day")}.
    </p> : null}
    <div className={styles.workDays}>{work.days.filter(day => day.active_ms > 0).map(day =>
      <span key={day.date} title={`${day.date}, ${recordTime(day.active_ms)}`}><span className="sr-only">{day.date}, {recordTime(day.active_ms)}</span><Stamp day={day} /></span>)}</div>
    {work.finished_on !== null ? <RecordCopyButton text={workRecordText(work, media.title)} /> : null}
  </section>;
}

function widthOf(work: Schema<"StackWorkOut">): number {
  switch (work.media.media_kind) {
    case "epub": return (work.words ?? 0) >= 150_000 ? 1 : (work.words ?? 0) >= 40_000 ? 0.9 : 0.8;
    case "pdf": return 0.84;
    case "web_article": return 0.72;
    case "podcast_episode": case "video": case "text_part": return 0.66;
    default: return assertNever(work.media.media_kind);
  }
}

function YearStack({ stack, currentYear, firstDay, width, compact, newIds, onWork }: {
  stack: StackYear;
  currentYear: number;
  firstDay: string | null;
  width: number;
  compact: boolean;
  newIds: ReadonlySet<string>;
  onWork: (id: string) => void;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const natural = compact ? 2.8 : 3.4;
  const naturalHeight = stack.works.reduce((sum, work) => sum + Math.max(2, work.thickness_mm * natural), 0);
  const reduction = Math.min(1, 900 / Math.max(1, naturalHeight));
  const heights = stack.works.map(work => Math.max(2, work.thickness_mm * natural) * reduction);
  const height = heights.reduce((sum, value) => sum + value, 0);
  const scale = stack.height_mm > 0 ? height / stack.height_mm : 0;
  const passed = MILESTONES.findLast(([mm]) => mm <= stack.height_mm);
  const next = MILESTONES.find(([mm]) => mm > stack.height_mm);
  const side = width < 420 ? 84 : 124;
  const column = Math.max(0, width - 30 - side);
  const thin: { id: string; works: Schema<"StackWorkOut">[]; bottom: number; height: number; active: number }[] = [];
  let bottom = 0;
  for (let i = 0; i < stack.works.length; i++) {
    const work = stack.works[i], previous = thin[thin.length - 1];
    if (heights[i] < 12) {
      if (i > 0 && heights[i - 1] < 12 && previous !== undefined) {
        previous.works.push(work); previous.height += heights[i]; previous.active += work.active_ms;
      } else thin.push({ id: work.media.media_id, works: [work], bottom, height: heights[i], active: work.active_ms });
    }
    bottom += heights[i];
  }
  const ticks = Math.max(1, Math.ceil(stack.height_mm / 100));
  const yearStart = `${stack.year}-01-01`;
  const since = firstDay !== null && firstDay > yearStart ? firstDay : yearStart;
  return <PaneSection title={`${stack.year} · the stack`}>
    {stack.works.length === 0 ? <Fact line={{ fact: `nothing finished in ${stack.year} yet.` }} /> : <>
      <p className={styles.stackFigure}><strong>{cm(stack.height_mm)}</strong><span>{pluralize(stack.works.length, "work")} finished {stack.year === currentYear
        ? `since ${recordDate(since)}` : `in ${stack.year}`}</span></p>
      <p className={styles.milestone}>{passed !== undefined ? `thicker than ${passed[1]}. ` : null}{next !== undefined ? `${cm(next[0] - stack.height_mm)} short of ${next[1]}.` : null}</p>
      <div className={styles.stack} style={{ paddingTop: next !== undefined && next[0] - stack.height_mm <= 20 ? `${(next[0] - stack.height_mm) * scale + 24}px` : 18 }}>
        <div className={styles.ruler} aria-hidden="true" style={{ height }}>
          {Array.from({ length: Math.floor(stack.height_mm / (ticks * 10)) + 1 }, (_, index) => index * ticks * 10).map(mm =>
            <span key={mm} style={{ bottom: `${stack.height_mm > 0 ? mm / stack.height_mm * 100 : 0}%` }}>{mm / 10}</span>)}
        </div>
        {next !== undefined && next[0] - stack.height_mm <= 20 ? <div className={styles.nextMilestone} aria-hidden="true" style={{ bottom: `${height + (next[0] - stack.height_mm) * scale}px` }}>{next[1]}</div> : null}
        <div className={styles.spines} style={{ width: column }}>
          {stack.works.map((work, index) => {
            const spineWidth = column * widthOf(work), spineHeight = heights[index];
            const author = byline(work.media), fontSize = Math.min(21, Math.max(10.5, spineHeight * 0.4));
            const flank = spineHeight >= 30 && fontSize >= 14 && spineWidth - Math.max(58, author.length * 5.4 + 34) * 2 >= work.media.title.length * 7;
            // borders impose a two-pixel layout floor; shrink the painted button below it.
            return <div key={work.media.media_id} className={styles.spineRow} style={{ height: spineHeight }}>
              <button type="button" className={styles.spine} onClick={() => onWork(work.media.media_id)}
                aria-label={`${work.media.title}, finished ${recordDate(work.finished_on)}, ${recordTime(work.active_ms)}, ${cm(work.thickness_mm)} in print`}
                data-new={stack.year === currentYear && newIds.has(work.media.media_id) || undefined}
                data-double={spineHeight >= 26 || undefined} data-flanked={flank || undefined}
                style={{ ...cloth(work.media), width: spineWidth, height: Math.max(2, spineHeight), fontSize,
                  transform: spineHeight < 2 ? `scaleY(${spineHeight / 2})` : undefined }}>
                {spineHeight >= 12 ? <>{flank ? <span className={styles.spineBy}>{author}</span> : null}
                  <span className={styles.spineTitle}>{work.media.title}</span>
                  {flank ? <span className={styles.spineYear}>{work.media.original_published_date?.slice(0, 4)}</span> : null}</> : null}
              </button>
              {spineHeight >= 12 ? <span className={styles.spineNote}><time dateTime={work.finished_on}>{recordDate(work.finished_on)}</time>
                {spineHeight >= 26 ? <span>{recordTime(work.active_ms)}</span> : null}</span> : null}
            </div>;
          })}
        </div>
        {thin.map(run => <div className={styles.shortNote} key={run.id} style={{ bottom: run.bottom + run.height / 2, left: column + 38 }}>
          <button type="button" onClick={() => setOpened(opened === run.id ? null : run.id)} aria-expanded={opened === run.id}>{pluralize(run.works.length, "short work")}</button>
          <span>{recordTime(run.active)}</span>
        </div>)}
      </div>
      {thin.filter(run => run.id === opened).map(run => <ul className={styles.shortWorks} key={run.id}>{run.works.map(work => <li key={work.media.media_id}>
        <Button onClick={() => onWork(work.media.media_id)}>{work.media.title}</Button><span>{recordTime(work.active_ms)}</span>
      </li>)}</ul>)}
    </>}
  </PaneSection>;
}

/** One record snapshot composes its three objects. Only the opened work performs another read. */
export default function RecordView({ record, workId, year, stale, onWork, onYear }: {
  record: Record;
  workId: string | null;
  year: number | null;
  stale: string;
  onWork: (id: string | null) => void;
  onYear: (year: number | null) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const resize = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  const currentYear = Number(record.today.slice(0, 4));
  const [seen, setSeen] = useState({ record, newIds: new Set<string>() });
  if (seen.record !== record) {
    const old = new Set(seen.record.stack.find(stack => stack.year === currentYear)?.works.map(work => work.media.media_id) ?? []);
    setSeen({ record, newIds: new Set(record.stack.find(stack => stack.year === currentYear)?.works.filter(work => !old.has(work.media.media_id)).map(work => work.media.media_id) ?? []) });
  }
  const seeds = [...record.open.map(work => work.media), ...record.stack.flatMap(stack => stack.works.map(work => work.media)),
    ...(record.in_hand !== null ? [record.in_hand.media] : []),
    ...(record.records.longest_sitting !== null ? [record.records.longest_sitting.media] : []),
    ...(record.records.longest_work !== null ? [record.records.longest_work.media] : [])];
  const summaries = useMediaSummaries(seeds);
  const open = record.open.flatMap(work => { const media = summaries.resolve(work.media); return media === null ? [] : [{ ...work, media }]; });
  const stacks = record.stack.map(stack => ({ ...stack, works: stack.works.flatMap(work => {
    const media = summaries.resolve(work.media); return media === null ? [] : [{ ...work, media }];
  }) }));
  const current = stacks.find(stack => stack.year === currentYear) ?? { year: currentYear, height_mm: 0, works: [] };
  const selected = stacks.find(stack => stack.year === year) ?? current;
  const otherYears = stacks.filter(stack => stack.year !== selected.year && (year === null || stack.year !== currentYear));
  if (year !== null) otherYears.unshift(current);
  const inHand = record.in_hand !== null ? summaries.resolve(record.in_hand.media) : null;
  const longest = record.records.longest_sitting;
  const longestMedia = longest !== null ? summaries.resolve(longest.media) : null;
  const longestWork = record.records.longest_work;
  const longestWorkMedia = longestWork !== null ? summaries.resolve(longestWork.media) : null;
  const compact = width < 560;
  return <div className={styles.record} ref={frame}>
    {record.in_hand !== null && inHand !== null ? <BookInHand work={record.in_hand} media={inHand} compact={compact} />
      : <Fact line={{ fact: "no open work read in the last 30 days." }} />}
    <div className={styles.columns}>
      <div className={styles.left}>
        <PaneSection title="open works, and what each will add">
          <ul className={styles.open}>{open.map(work => <li key={work.media.media_id}>
            <span className={styles.bar} style={{ borderColor: cloth(work.media).backgroundColor }} aria-hidden="true">
              {work.covered.map(([start, end]) => <i key={start} style={{ left: `${start * 100}%`, width: `${(end - start) * 100}%`, backgroundColor: cloth(work.media).backgroundColor }} />)}
            </span>
            <a className={styles.openTitle} href={`/media/${work.media.media_id}`}><MediaTitle subject={{ kind: "Stored", summary: work.media }} className={styles.titleText} /></a>
            <span className={styles.gain}>+ {cm(work.thickness_mm)}</span>
          </li>)}</ul>
        </PaneSection>
        <div>
          <YearStack stack={selected} currentYear={currentYear} firstDay={record.records.first_day}
            width={width < 720 ? width : (width - 28) * 0.54} compact={compact} newIds={seen.newIds} onWork={onWork} />
          {workId !== null ? <WorkRecord key={workId} mediaId={workId} stale={stale} compact={compact} onClose={() => onWork(null)} />
            : selected.works.length > 0 ? <><p className={styles.print}>each as thick as it would be in print.</p><RecordCopyButton text={stackRecordText(selected, record.slip.days)} /></> : null}
          <div className={styles.years}>
            {otherYears.map(stack => <Button key={stack.year} onClick={() => onYear(stack.year === currentYear ? null : stack.year)}>
              {stack.year} · {cm(stack.height_mm)} · {pluralize(stack.works.length, "work")}
            </Button>)}
            {stacks.length > 0 ? <p>all years · {cm(record.lifetime_mm)}</p> : null}
          </div>
        </div>
        <PaneSection title="records">
          <dl className={styles.records}>
            {longest !== null && longestMedia !== null ? <div><dt>longest sitting</dt><dd>{recordTime(longest.active_ms)} · {longestMedia.title}</dd></div> : null}
            {record.records.fullest_day !== null ? <div><dt>fullest day</dt><dd>{recordTime(record.records.fullest_day.active_ms)} · {recordDate(record.records.fullest_day.date)}</dd></div> : null}
            {longestWork !== null && longestWorkMedia !== null ? <div><dt>longest work finished</dt><dd>{longestWork.words.toLocaleString("en")} {longestWork.words === 1 ? "word" : "words"} · {longestWorkMedia.title}</dd></div> : null}
            {record.records.observed_ms > 0 ? <div><dt>observed time</dt><dd>{recordTime(record.records.observed_ms)}</dd></div> : null}
          </dl>
        </PaneSection>
      </div>
      <Slip slip={record.slip} today={record.today} firstDay={record.records.first_day} />
    </div>
  </div>;
}
