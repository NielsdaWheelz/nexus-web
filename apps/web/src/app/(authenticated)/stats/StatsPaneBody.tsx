"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import Input from "@/components/ui/Input";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import PaneSection from "@/components/ui/PaneSection";
import SelectField from "@/components/ui/SelectField";
import { useFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { useCursorPagination, type CursorPage } from "@/lib/api/useCursorPagination";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import { useResource, type AsyncResource } from "@/lib/api/useResource";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  publishConsumptionProjectionChange,
  useConsumptionProjectionRevision,
} from "@/lib/consumption/projectionRevision";
import { formatLocalDateInTimeZone } from "@/lib/localDate";
import {
  requirePaneRuntime,
  usePaneIsActive,
  usePaneReturnReady,
  usePaneRuntime,
  usePaneSearchParams,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import { useHydratedBrowserTimeZone } from "@/lib/time/browserTimeZone";
import ActivityHealth from "./ActivityHealth";
import { browserToday, periodStart, shiftAnchor, statsQuery, statsUrlCodec } from "./statsPeriod";
import type { FilterKey, StatsPeriod, StatsUrlState } from "./statsPeriod";
import styles from "./StatsPaneBody.module.css";

type Stats = Schema<"ConsumptionStatsOut">;
type Session = Schema<"ActivitySessionOut">;
type Exclusion = Schema<"ActiveExclusionOut">;
type Committed = { query: string; state: StatsUrlState; data: Stats };
type Correction =
  | Omit<Schema<"ExcludeActivityIn">, "clientMutationId">
  | Omit<Schema<"RestoreActivityExclusionIn">, "clientMutationId">;
type OnFilter = (key: FilterKey, value: string) => void;
type OnRestore = (row: Exclusion) => void;
/** A table row: its React key, its row header, then its cells. */
type Row = [key: string, header: ReactNode, ...cells: ReactNode[]];
type SectionProps = {
  title: string;
  description?: string;
  scope?: { appliedFilters: string[]; inapplicableFilters: string[] };
  children: ReactNode;
};

const PERIOD_LABEL = { day: "Day", week: "Week", month: "Month", year: "Year", all: "All time" };
const MODALITIES = ["Reading", "Listening", "Viewing"] as const;
const MODALITY_MS = {
  Reading: "readingActiveMs",
  Listening: "listeningActiveMs",
  Viewing: "viewingActiveMs",
} as const;
const SHORT_DATE = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } as const;
const RETRY = { title: "Activity wasn’t changed", message: "Check your connection and retry." };
const GONE = { title: "That activity is no longer available" };
const STALE = {
  title: "Activity changed before this correction",
  message: "Review the refreshed history and retry if needed.",
};
/** The HUD of an expected correction failure; any other failure is a defect. */
const CORRECTION_FAILURES: Record<string, { title: string; message?: string }> = {
  E_UNAUTHENTICATED: { title: "Sign in again to change activity" },
  E_NETWORK: RETRY,
  E_UPSTREAM: RETRY,
  E_UPSTREAM_TIMEOUT: RETRY,
  E_RATE_LIMITED: RETRY,
  E_MEDIA_NOT_FOUND: GONE,
  E_NOT_FOUND: GONE,
  E_INVALID_REQUEST: STALE,
  E_RESOURCE_CONFLICT: STALE,
};

const pad = (value: number) => String(value).padStart(2, "0");
const count = (value: number) => new Intl.NumberFormat().format(value);
const hourLabel = (hour: number) => `${pad(hour)}:00`;
const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const shortDate = (instant: string) => new Date(instant).toLocaleString(undefined, SHORT_DATE);
const movement = (words: number, mediaMs: number) =>
  words > 0 ? `${count(words)} words` : duration(mediaMs);
const periodName = (state: StatsUrlState) =>
  state.view === "year" ? state.year : PERIOD_LABEL[state.period];

function page(rows: Session[], cursor: Schema<"ActivitySessionsOut">["nextCursor"]) {
  const next = cursor.kind === "Present" ? cursor.value : null;
  return { data: rows, page: { has_more: next !== null, next_cursor: next } };
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes / 60}h`;
}

function utcOffset(minutes: number): string {
  const absolute = Math.abs(minutes);
  return `UTC${minutes < 0 ? "-" : "+"}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** The first row with the most active time, if any row has some. */
function peak<T extends { activeMs: number }>(rows: T[]): T | undefined {
  return rows.reduce<T | undefined>(
    (best, row) => (row.activeMs > (best?.activeMs ?? 0) ? row : best),
    undefined,
  );
}

function Facts(props: { className: string; label?: string; facts: [string, ReactNode][] }) {
  const { className, label, facts } = props;
  return (
    <dl className={className} aria-label={label}>
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, description, scope, children }: SectionProps) {
  const notApplied = scope?.inapplicableFilters.join(", ");
  return (
    <PaneSection className={styles.section} title={title} description={description}>
      {children}
      {scope ? (
        <p className={styles.scope}>
          <strong>Applies:</strong> {scope.appliedFilters.join(", ")}.
          {notApplied ? <> <strong>Not applied:</strong> {notApplied}.</> : null}
        </p>
      ) : null}
    </PaneSection>
  );
}

function Table({ head, rows }: { head: string[]; rows: Row[] }) {
  return (
    <table>
      <thead>
        <tr>
          {head.map((label) => (
            <th key={label} scope="col">
              {label === "Actions" ? <span className="sr-only">Actions</span> : label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(([key, header, ...cells]) => (
          <tr key={key}>
            <th scope="row">{header}</th>
            {cells.map((cell, index) => <td key={index}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WorkLink({ mediaRef, title }: { mediaRef: string; title: string }) {
  const paneRuntime = usePaneRuntime();
  const target = { href: `/media/${mediaRef.slice("media:".length)}`, labelHint: title };
  return (
    <button
      type="button"
      className={styles.rowLink}
      onClick={(event) =>
        requirePaneRuntime(paneRuntime, "Stats work target activation").activateTarget({
          target,
          disposition: workspaceTargetClickIntent(event).disposition,
        })
      }
    >
      {title}
    </button>
  );
}

/** A session or exclusion: its work, "modality · device · start", and its one correction. */
function SessionCell(props: { title: ReactNode; row: Session | Exclusion; action: ReactNode }) {
  const { row } = props;
  const when = `${row.modality} · ${row.device.label} · ${shortDate(row.startedAt)}`;
  const clipped =
    "continuesBeforeRange" in row && (row.continuesBeforeRange || row.continuesAfterRange);
  return (
    <div className={styles.sessionCell}>
      <div>
        {props.title}
        <span className={styles.muted}>{clipped ? `${when} · continues beyond range` : when}</span>
      </div>
      {props.action}
    </div>
  );
}

function Timeline({ data }: { data: Stats }) {
  const rows = data.activity.timeline;
  const max = Math.max(...rows.map((row) => row.activeMs), 1);
  const width = 320 / Math.max(rows.length, 1);
  return (
    <Section
      title="Activity over time"
      description="Observed active time, in your local time."
      scope={data.activity}
    >
      <div className={styles.legend}>
        {MODALITIES.map((modality) => (
          <span key={modality} className={styles[`legend${modality}`]}>
            {modality}
          </span>
        ))}
      </div>
      <svg className={styles.chart} aria-hidden viewBox="0 0 320 86" preserveAspectRatio="none">
        {rows.map((row, index) => {
          let top = 86;
          return (
            <g key={row.start}>
              {MODALITIES.map((modality) => {
                const height = (row[MODALITY_MS[modality]] / max) * 82;
                top -= height;
                const bar = { x: index * width, y: top, width: Math.max(1, width - 1), height };
                return <rect key={modality} className={styles[`bar${modality}`]} {...bar} />;
              })}
            </g>
          );
        })}
      </svg>
      <Table
        head={["Local time", ...MODALITIES, "Total"]}
        rows={rows.map((row) => [
          `${row.start}-${row.end}`,
          <>
            {row.localLabel}{" "}
            <span className={styles.muted}>({utcOffset(row.utcOffsetMinutes)})</span>
          </>,
          ...MODALITIES.map((modality) => duration(row[MODALITY_MS[modality]])),
          duration(row.activeMs),
        ])}
      />
    </Section>
  );
}

function DaysAndHours({ data }: { data: Stats }) {
  const { localDays, localHours } = data.activity;
  const dayMax = Math.max(...localDays.map((row) => row.activeMs), 1);
  const hourMax = Math.max(...localHours.map((row) => row.activeMs), 1);
  return (
    <div className={styles.grid}>
      <Section
        title="Active local days"
        description="Each square is one local calendar day."
        scope={data.activity}
      >
        <div className={styles.heatmap} aria-hidden>
          {localDays.map((row) => (
            <span
              key={row.date}
              style={{ opacity: 0.15 + (row.activeMs / dayMax) * 0.85 }}
              title={`${dayLabel(row.date)}: ${duration(row.activeMs)}`}
            />
          ))}
        </div>
        <Table
          head={["Date", "Active time"]}
          rows={localDays.map((row) => [row.date, dayLabel(row.date), duration(row.activeMs)])}
        />
      </Section>
      <Section title="Time of day" description="Active time by local hour." scope={data.activity}>
        <div className={styles.hours} aria-hidden>
          {localHours.map((row) => (
            <span
              key={row.hour}
              style={{ height: `${Math.max(3, (row.activeMs / hourMax) * 100)}%` }}
            />
          ))}
        </div>
        <Table
          head={["Local hour", "Active time"]}
          rows={localHours.map((row) => [
            `${row.hour}`,
            hourLabel(row.hour),
            duration(row.activeMs),
          ])}
        />
      </Section>
    </div>
  );
}

/** Top works and contributors, and in the stats view devices, each row with a Filter action. */
function Breakdowns({ data, onFilter }: { data: Stats; onFilter?: OnFilter }) {
  const { media, contributors, devices } = data.activity;
  const actions = onFilter ? ["Actions"] : [];
  const filter = (label: string, key: FilterKey, value: string) =>
    onFilter
      ? [
          <Button
            key="filter"
            size="sm"
            variant="ghost"
            aria-label={`Filter ${label}`}
            onClick={() => onFilter(key, value)}
          >
            Filter
          </Button>,
        ]
      : [];
  return (
    <>
      <Section
        title="Top works"
        description={
          media.otherActiveMs ? `${duration(media.otherActiveMs)} in other works.` : undefined
        }
        scope={data.activity}
      >
        <Table
          head={["Work", "Active time", "Forward movement", ...actions]}
          rows={media.rows.map((row) => [
            row.mediaRef,
            <WorkLink key="work" mediaRef={row.mediaRef} title={row.title} />,
            duration(row.activeMs),
            movement(row.forwardWordPosition, row.forwardMediaPositionMs),
            ...filter(`work: ${row.title}`, "media", row.mediaRef),
          ])}
        />
      </Section>
      <Section
        title="Contributors"
        description="Each credited person is fully credited; totals are not additive."
        scope={data.activity}
      >
        <Table
          head={["Contributor", "Roles", "Active time", ...actions]}
          rows={contributors.rows.map((row) => [
            row.contributorHandle,
            row.displayName,
            row.roles.join(", ") || "—",
            duration(row.activeMs),
            ...filter(`contributor: ${row.displayName}`, "contributor", row.contributorHandle),
          ])}
        />
      </Section>
      {onFilter ? (
        <Section
          title="Devices"
          description="A sealed device label, never a raw device identifier."
          scope={data.activity}
        >
          <Table
            head={["Device", "Active time", "Current", ...actions]}
            rows={devices.map((row) => [
              row.deviceHandle,
              row.label,
              duration(row.activeMs),
              row.isCurrent ? "Current device" : "",
              ...filter(`device: ${row.label}`, "device", row.deviceHandle),
            ])}
          />
        </Section>
      ) : null}
    </>
  );
}

function Sessions(props: {
  data: Stats;
  sessions: ReturnType<typeof useCursorPagination<Session>>;
  more: boolean;
  correcting: boolean;
  onExclude: (row: Session) => void;
}) {
  const { sessions, correcting } = props;
  const exclude = (row: Session) =>
    row.continuesBeforeRange || row.continuesAfterRange ? null : (
      <ActionMenu
        label={`Actions for ${row.title}, ${row.modality}, ${shortDate(row.startedAt)}`}
        triggerDisabled={correcting}
        triggerDisabledReason="Another activity correction is in progress"
        options={[
          {
            kind: "command",
            id: "Consumption.Activity.ExcludeSession",
            label: "Don’t count this session",
            onSelect: () => props.onExclude(row),
          },
        ]}
      />
    );
  return (
    <Section
      title="Sessions"
      description="Server-derived sessions; time is clipped to this range."
      scope={props.data.activity}
    >
      <Table
        head={["Session", "Active time", "Movement"]}
        rows={sessions.items.map((row) => [
          [row.mediaRef, row.modality, row.device.deviceHandle, row.startedAt].join(),
          <SessionCell
            key="session"
            title={<WorkLink mediaRef={row.mediaRef} title={row.title} />}
            row={row}
            action={exclude(row)}
          />,
          duration(row.activeMs),
          movement(row.forwardWordPosition, row.forwardMediaPositionMs),
        ])}
      />
      {sessions.error !== null ? (
        <div className={styles.sessionLoadFailure} role="alert">
          <span>Sessions couldn’t load</span>
          <Button size="sm" variant="secondary" onClick={sessions.retry}>
            Retry loading sessions
          </Button>
        </div>
      ) : (
        <LoadMoreFooter
          hasMore={props.more && sessions.nextCursor !== null}
          loading={sessions.loadingMore}
          onLoadMore={sessions.loadMore}
          label="Load more sessions"
        />
      )}
    </Section>
  );
}

function Exclusions(props: { data: Stats; correcting: boolean; onRestore: OnRestore }) {
  const { activeExclusions } = props.data.activity;
  if (activeExclusions.length === 0) return null;
  return (
    <Section
      title="Excluded activity"
      description="Observed sessions you chose not to count."
      scope={props.data.activity}
    >
      <Table
        head={["Session", "Excluded time"]}
        rows={activeExclusions.map((row) => [
          row.exclusionHandle,
          <SessionCell
            key="session"
            title={row.title}
            row={row}
            action={
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Restore ${row.title} session from ${shortDate(row.startedAt)}`}
                disabled={props.correcting}
                onClick={() => props.onRestore(row)}
              >
                Restore
              </Button>
            }
          />,
          duration(row.excludedActiveMs),
        ])}
      />
    </Section>
  );
}

function Outcomes({ data }: { data: Stats }) {
  const { completion, retainedArtifacts: kept } = data;
  return (
    <>
      <Section
        title="Completions"
        description="Completion facts recorded in this selected period."
        scope={completion}
      >
        <p className={styles.completionTotal}>
          <strong>{count(completion.total)}</strong> completed
        </p>
        <Table
          head={["Work", "Completions"]}
          rows={completion.media.map((row) => [
            row.mediaRef,
            <WorkLink key="work" mediaRef={row.mediaRef} title={row.title} />,
            count(row.total),
          ])}
        />
        <Table
          head={["Contributor", "Roles", "Completions"]}
          rows={completion.contributors.map((row) => [
            row.contributorHandle,
            row.displayName,
            row.roles.join(", ") || "—",
            count(row.total),
          ])}
        />
      </Section>
      <Section
        title="Created and kept"
        description="Period-wide artifacts; consumption filters do not apply."
        scope={kept}
      >
        <Facts
          className={styles.artifacts}
          facts={[
            ["Highlights", count(kept.highlights)],
            ["Note blocks", count(kept.noteBlocks)],
            ["Links", count(kept.neutralLinks)],
          ]}
        />
      </Section>
    </>
  );
}

function YearInReading({ data, year }: { data: Stats; year: number }) {
  const { localDays, localHours, longestSession, media, timeline, totals } = data.activity;
  const peakDay = peak(localDays);
  const peakHour = peak(localHours);
  const cover = media.rows[0]?.title;
  const longest = longestSession.kind === "Present" ? longestSession.value : null;
  return (
    <div>
      <header className={styles.yearHero}>
        <p>Year in Reading</p>
        <div
          className={styles.cover}
          aria-label={cover ? `Cover for ${cover}` : "No cover available"}
        >
          {cover?.slice(0, 1)}
        </div>
        <h2>{year}</h2>
        <span>Observed time</span>
        <strong>{duration(totals.activeMs)}</strong>
      </header>
      <Facts
        className={styles.summary}
        facts={[
          ["Peak day", peakDay ? `${dayLabel(peakDay.date)} · ${duration(peakDay.activeMs)}` : "—"],
          [
            "Peak hour",
            peakHour ? `${hourLabel(peakHour.hour)} · ${duration(peakHour.activeMs)}` : "—",
          ],
          ["Completions", count(data.completion.total)],
        ]}
      />
      <Timeline data={data} />
      <Section title="Modality composition">
        <Table
          head={["Mode", "Active time"]}
          rows={MODALITIES.map((modality) => [
            modality,
            modality,
            duration(timeline.reduce((sum, row) => sum + row[MODALITY_MS[modality]], 0)),
          ])}
        />
      </Section>
      {longest ? (
        <Section title="Longest session">
          <p className={styles.longest}>
            <strong>{longest.title}</strong>
            <span>
              {duration(longest.activeMs)} · {longest.modality} · {shortDate(longest.startedAt)}
            </span>
          </p>
        </Section>
      ) : null}
      <Breakdowns data={data} />
      <Outcomes data={data} />
    </div>
  );
}

function Controls(props: {
  state: StatsUrlState;
  update: (next: Partial<StatsUrlState>) => void;
  onFilter: OnFilter;
  chipLabel: (key: "media" | "contributor" | "device", value: string) => string;
}) {
  const { state, update, onFilter } = props;
  const today = browserToday();
  const thisYear = Number(today.slice(0, 4));
  const yearView = state.view === "year";
  const shift = (amount: number) => shiftAnchor(state.anchor, state.period, amount);
  const move = (amount: number) =>
    update(yearView ? { year: state.year + amount } : { anchor: shift(amount) });
  const canGoNext = yearView
    ? state.year < thisYear
    : periodStart(shift(1), state.period) <= periodStart(today, state.period);
  const chips = (["media", "contributor", "device"] as const).flatMap((key) => {
    const value = state.filters[key];
    return value ? [[key, value] as const] : [];
  });
  const view = (name: StatsUrlState["view"]) => ({
    size: "sm",
    variant: state.view === name ? "primary" : "secondary",
    "aria-pressed": state.view === name,
  }) as const;
  return (
    <div className={styles.controls}>
      <div role="group" aria-label="Stats view">
        <Button {...view("stats")} onClick={() => update({ view: "stats" })}>
          Stats
        </Button>
        <Button {...view("year")} onClick={() => update({ view: "year", period: "year" })}>
          Year
        </Button>
      </div>
      {yearView ? (
        <label>
          Year
          <Input
            type="number"
            size="sm"
            min="1970"
            max={thisYear}
            value={state.year}
            onChange={(event) => update({ year: Number(event.target.value) || thisYear })}
          />
        </label>
      ) : (
        <>
          <SelectField
            layout="Stacked"
            label="Period"
            size="sm"
            value={state.period}
            onChange={(event) => update({ period: event.target.value as StatsPeriod })}
          >
            {Object.entries(PERIOD_LABEL).map(([period, label]) => (
              <option key={period} value={period}>
                {label}
              </option>
            ))}
          </SelectField>
          <label>
            Anchor
            <Input
              type="date"
              size="sm"
              value={state.anchor}
              onChange={(event) => update({ anchor: event.target.value })}
            />
          </label>
        </>
      )}
      {yearView || state.period !== "all" ? (
        <div role="group" aria-label={yearView ? "Year navigation" : "Date navigation"}>
          <Button size="sm" variant="secondary" onClick={() => move(-1)}>
            Previous
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => update(yearView ? { year: thisYear } : { anchor: today })}
          >
            {yearView ? "This year" : "Today"}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => move(1)} disabled={!canGoNext}>
            Next
          </Button>
        </div>
      ) : null}
      {yearView ? null : (
        <>
          <SelectField
            layout="Stacked"
            label="Modality"
            size="sm"
            value={state.filters.modality ?? ""}
            onChange={(event) => onFilter("modality", event.target.value)}
          >
            <option value="">All</option>
            {MODALITIES.map((modality) => (
              <option key={modality}>{modality}</option>
            ))}
          </SelectField>
          {chips.map(([key, value]) => (
            <Chip
              key={key}
              size="md"
              removable
              removeLabel={`Clear ${key} filter`}
              onRemove={() => onFilter(key, "")}
            >
              {props.chipLabel(key, value)}
            </Chip>
          ))}
        </>
      )}
    </div>
  );
}

export default function StatsPaneBody() {
  const feedback = useFeedback();
  const timeZone = useHydratedBrowserTimeZone();
  const projection = useConsumptionProjectionRevision();
  const isPaneActive = usePaneIsActive();
  const searchParams = usePaneSearchParams();
  const { state, setState } = usePaneUrlState(statsUrlCodec);
  const [lifecycle, setLifecycle] = useState(0);
  const [correcting, setCorrecting] = useState(false);
  const [correctionDefect, setCorrectionDefect] = useState<unknown>(null);
  const mutationIds = useRef(new Map<string, string>());
  const wasActive = useRef(isPaneActive);
  const priorTimeZone = useRef<string | null>(null);
  const previous = useRef<Committed | null>(null);
  useSetPaneLabel(state.view === "year" ? "Year in Reading" : "Stats");
  const update = (next: Partial<StatsUrlState>) => setState({ ...state, ...next });

  // Revalidate when the pane returns to the foreground or the page to the screen.
  useEffect(() => {
    if (isPaneActive && !wasActive.current) setLifecycle((n) => n + 1);
    wasActive.current = isPaneActive;
  }, [isPaneActive]);
  useEffect(() => {
    const revalidate = () => {
      if (document.visibilityState === "visible") setLifecycle((n) => n + 1);
    };
    const events = ["focus", "pageshow", "online"] as const;
    document.addEventListener("visibilitychange", revalidate);
    for (const event of events) window.addEventListener(event, revalidate);
    return () => {
      document.removeEventListener("visibilitychange", revalidate);
      for (const event of events) window.removeEventListener(event, revalidate);
    };
  }, []);

  // Nothing is fetched until the URL is canonical, which it is made once the zone is known.
  const canonical = `${searchParams}` === `${statsUrlCodec.encode(state, searchParams)}`;
  useEffect(() => {
    if (timeZone && !canonical) setState(state);
  }, [timeZone, canonical, setState, state]);
  // A view anchored on today follows today into a newly detected time zone.
  useEffect(() => {
    if (timeZone === null) return;
    const prior = priorTimeZone.current;
    priorTimeZone.current = timeZone;
    if (prior === null || prior === timeZone || state.view !== "stats") return;
    const today = formatLocalDateInTimeZone(new Date(), timeZone);
    const onToday = state.anchor === formatLocalDateInTimeZone(new Date(), prior);
    if ((state.period === "all" || onToday) && state.anchor !== today) {
      setState({ ...state, anchor: today });
    }
  }, [timeZone, state, setState]);

  const query = timeZone && canonical ? statsQuery(state, timeZone).toString() : null;
  const resource = useResource<Committed>({
    cacheKey: query === null ? null : `${query}\u0000${projection.revision}\u0000${lifecycle}`,
    load: async (signal) => {
      const url = `/api/consumption/stats?${query}` as const;
      const body = await apiFetch<ApiJson<"/consumption/stats", "get">>(url, { signal });
      return { query: query!, state, data: body.data };
    },
  });
  // The prior result stays on screen while a new query or a revalidation loads.
  const fresh = resource.status === "ready" && resource.data.query === query ? resource.data : null;
  if (fresh !== null) previous.current = fresh;
  const committed = fresh ?? previous.current;
  const data = committed?.data ?? null;
  const fetching =
    query !== null && (resource.status === "loading" || (resource.status === "ready" && !fresh));
  const initialLoading = query === null || (fetching && data === null);
  const updating = fetching && data !== null;
  usePaneReturnReady(!initialLoading);

  const firstPage = useMemo<AsyncResource<CursorPage<Session>>>(() => {
    if (data === null) return { status: "loading" };
    const { rows, nextCursor } = data.activity.sessions;
    return { status: "ready", data: page(rows, nextCursor) };
  }, [data]);
  // Continuations reuse the committed query, so the cursor's snapshot and scope always match.
  const sessions = useCursorPagination<Session>({
    firstPage,
    initialMoreError: null,
    loadMorePage: async (cursor, signal) => {
      const params = new URLSearchParams(committed!.query);
      params.set("limit", "50");
      params.set("cursor", cursor);
      const url = `/api/consumption/sessions?${params}` as const;
      const body = await apiFetch<ApiJson<"/consumption/sessions", "get">>(url, { signal });
      return page(body.data.sessions, body.data.nextCursor);
    },
  });

  // One correction at a time. A command keeps its mutation id until it succeeds, so a retry of
  // the same correction replays instead of applying twice.
  const correct = async (command: Correction, confirmation: string, success: string) => {
    if (correcting || !window.confirm(confirmation)) return;
    const key = JSON.stringify(command);
    const clientMutationId = mutationIds.current.get(key) ?? crypto.randomUUID();
    mutationIds.current.set(key, clientMutationId);
    const hud = (content: FeedbackContent) =>
      feedback.publish({ kind: "Hud", key: "consumption-activity-correction", content });
    setCorrecting(true);
    try {
      const init = { method: "POST", body: JSON.stringify({ ...command, clientMutationId }) };
      await apiFetch<ApiJson<"/consumption/activity-exclusions", "post">>(
        "/api/consumption/activity-exclusions",
        init,
      );
      mutationIds.current.delete(key);
      publishConsumptionProjectionChange();
      hud({ tone: "Success", title: success });
    } catch (error) {
      const expected = isApiError(error) && !isSameSystemApiDefect(error);
      const failure = expected ? CORRECTION_FAILURES[error.code] : undefined;
      if (!isApiError(error) || failure === undefined) return setCorrectionDefect(error);
      if (error.code === "E_UNAUTHENTICATED") handleUnauthenticatedApiError(error);
      hud({ tone: "Warning", ...failure, requestId: error.requestId });
      if (failure === STALE) publishConsumptionProjectionChange();
    } finally {
      setCorrecting(false);
    }
  };
  const exclude = ({ mediaRef, modality, device, startedAt, endedAt, activeMs }: Session) =>
    void correct(
      {
        kind: "Exclude",
        mediaRef,
        modality,
        deviceHandle: device.deviceHandle,
        startedAt,
        endedAt,
      },
      `Don’t count this ${duration(activeMs)} session?`,
      "Session excluded",
    );
  const restore = (row: Exclusion) =>
    void correct(
      { kind: "Restore", exclusionHandle: row.exclusionHandle },
      `Count this ${duration(row.excludedActiveMs)} session again?`,
      "Session restored",
    );
  if (correctionDefect !== null) throw correctionDefect;

  const yearView = state.view === "year";
  const today = browserToday();
  const live =
    state.period === "all" ||
    periodStart(state.anchor, state.period) === periodStart(today, state.period);
  const setFilter = (key: FilterKey, value: string) =>
    update({ filters: { ...state.filters, [key]: value || undefined } });
  const chipLabel = (key: "media" | "contributor" | "device", value: string) => {
    const activity = data?.activity;
    const label =
      key === "media"
        ? activity?.media.rows.find((row) => row.mediaRef === value)?.title
        : key === "contributor"
          ? activity?.contributors.rows.find((row) => row.contributorHandle === value)?.displayName
          : activity?.devices.find((row) => row.deviceHandle === value)?.label;
    return label ?? `Selected ${key === "media" ? "work" : key}`;
  };
  const totals = data?.activity.totals;
  const kept = data?.retainedArtifacts;
  const wholeEmpty =
    data !== null &&
    totals!.activeMs === 0 &&
    data.completion.total === 0 &&
    kept!.highlights + kept!.noteBlocks + kept!.neutralLinks === 0 &&
    data.activity.activeExclusions.length === 0;
  const retry = resource.status === "error" && (
    <Button size="sm" variant="secondary" onClick={resource.retry}>
      Retry
    </Button>
  );

  return (
    <main className={styles.pane} aria-busy={updating || initialLoading}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>
            {yearView ? "A factual annual record" : "Consumption activity"}
          </p>
          <p className={styles.timeZone}>Local time · {timeZone ?? "detecting your time zone"}</p>
        </div>
        <Controls state={state} update={update} onFilter={setFilter} chipLabel={chipLabel} />
      </header>
      <ActivityHealth />
      {updating ? (
        <p className={styles.busy} role="status">
          Updating {periodName(state)}. Showing the prior {periodName(committed!.state)} result
          until it arrives.
        </p>
      ) : null}
      {initialLoading ? <div className={styles.loading} aria-label="Loading statistics" /> : null}
      {retry && data === null ? (
        <section className={styles.state} role="alert">
          <h2>Stats could not load</h2>
          <p>Try again. Nothing has been changed.</p>
          {retry}
        </section>
      ) : null}
      {retry && data !== null ? (
        <p className={styles.busy} role="status">
          Could not refresh this view. Showing the last loaded result. {retry}
        </p>
      ) : null}
      {totals?.recordedActiveMs === 0 ? (
        <section className={styles.state}>
          {data!.activity.appliedFilters.length > 1 ? (
            <>
              <h2>No activity matches this view</h2>
              <p>Try a broader period.</p>
            </>
          ) : (
            <>
              <h2>No observed activity yet</h2>
              <p>
                New reading, listening, and video-pane activity will appear here when it is
                recorded.
              </p>
            </>
          )}
        </section>
      ) : null}
      {data === null || totals === undefined || wholeEmpty ? null : yearView ? (
        <YearInReading data={data} year={state.year} />
      ) : totals.activeMs === 0 ? (
        <>
          <Exclusions data={data} correcting={correcting} onRestore={restore} />
          <Outcomes data={data} />
        </>
      ) : (
        <>
          <Facts
            className={styles.summary}
            label="Activity summary"
            facts={[
              ["Observed time", duration(totals.activeMs)],
              ["Active days", count(totals.activeDays)],
              [
                live ? "Current streak" : "Ending streak",
                <>
                  {count(totals.streak)} days <small>best {count(totals.longestStreak)}</small>
                </>,
              ],
              ["Sessions", count(totals.sessionCount)],
              [
                "Forward movement",
                totals.forwardWordPosition > 0 || totals.forwardMediaPositionMs > 0
                  ? movement(totals.forwardWordPosition, totals.forwardMediaPositionMs)
                  : "—",
              ],
              ["Completions", count(data.completion.total)],
            ]}
          />
          <Timeline data={data} />
          <DaysAndHours data={data} />
          <Breakdowns data={data} onFilter={setFilter} />
          <Sessions
            data={data}
            sessions={sessions}
            more={!updating}
            correcting={correcting}
            onExclude={exclude}
          />
          <Exclusions data={data} correcting={correcting} onRestore={restore} />
          <Outcomes data={data} />
        </>
      )}
    </main>
  );
}
