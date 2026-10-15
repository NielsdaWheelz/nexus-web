"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import Input from "@/components/ui/Input";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import PaneSection from "@/components/ui/PaneSection";
import SelectField from "@/components/ui/SelectField";
import { useFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { usePaneFreeServerList, type ServerList } from "@/lib/api/useServerList";
import { usePaneUrlState } from "@/lib/panes/usePaneUrlState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { publishChange, useChangeStamp } from "@/lib/api/changes";
import { formatLocalDateInTimeZone } from "@/lib/localDate";
import {
  requirePaneRuntime,
  usePaneIsActive,
  usePaneRuntime,
  usePaneSearchParams,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import { useHydratedBrowserTimeZone } from "@/lib/time/browserTimeZone";
import { browserToday, periodStart, shiftAnchor, statsQuery, statsUrlCodec } from "./statsPeriod";
import type { FilterKey, StatsPeriod, StatsUrlState } from "./statsPeriod";
import styles from "./StatsPaneBody.module.css";

type Stats = Schema<"ConsumptionStatsOut">;
type Session = Schema<"ActivitySessionOut">;
type Exclusion = Schema<"ActiveExclusionOut">;
type Committed = { query: string; read: string; state: StatsUrlState; data: Stats };
type Correction =
  | Omit<Schema<"ExcludeActivityIn">, "client_mutation_id">
  | Omit<Schema<"RestoreActivityExclusionIn">, "client_mutation_id">;
type OnFilter = (key: FilterKey, value: string) => void;
type OnRestore = (row: Exclusion) => void;
/** A table row: its React key, its row header, then its cells. */
type Row = [key: string, header: ReactNode, ...cells: ReactNode[]];
type SectionProps = {
  title: string;
  description?: string;
  scope?: { applied_filters: string[]; inapplicable_filters: string[] };
  children: ReactNode;
};

const PERIOD_LABEL = { day: "Day", week: "Week", month: "Month", year: "Year", all: "All time" };
const MODALITIES = ["Reading", "Listening", "Viewing"] as const;
const MODALITY_MS = {
  Reading: "reading_active_ms",
  Listening: "listening_active_ms",
  Viewing: "viewing_active_ms",
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
function peak<T extends { active_ms: number }>(rows: T[]): T | undefined {
  return rows.reduce<T | undefined>(
    (best, row) => (row.active_ms > (best?.active_ms ?? 0) ? row : best),
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
  const notApplied = scope?.inapplicable_filters.join(", ");
  return (
    <PaneSection className={styles.section} title={title} description={description}>
      {children}
      {scope ? (
        <p className={styles.scope}>
          <strong>Applies:</strong> {scope.applied_filters.join(", ")}.
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
  const when = `${row.modality} · ${row.device.label} · ${shortDate(row.started_at)}`;
  const clipped =
    "continues_before_range" in row && (row.continues_before_range || row.continues_after_range);
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
  const max = Math.max(...rows.map((row) => row.active_ms), 1);
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
            {row.local_label}{" "}
            <span className={styles.muted}>({utcOffset(row.utc_offset_minutes)})</span>
          </>,
          ...MODALITIES.map((modality) => duration(row[MODALITY_MS[modality]])),
          duration(row.active_ms),
        ])}
      />
    </Section>
  );
}

function DaysAndHours({ data }: { data: Stats }) {
  const { local_days: localDays, local_hours: localHours } = data.activity;
  const dayMax = Math.max(...localDays.map((row) => row.active_ms), 1);
  const hourMax = Math.max(...localHours.map((row) => row.active_ms), 1);
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
              style={{ opacity: 0.15 + (row.active_ms / dayMax) * 0.85 }}
              title={`${dayLabel(row.date)}: ${duration(row.active_ms)}`}
            />
          ))}
        </div>
        <Table
          head={["Date", "Active time"]}
          rows={localDays.map((row) => [row.date, dayLabel(row.date), duration(row.active_ms)])}
        />
      </Section>
      <Section title="Time of day" description="Active time by local hour." scope={data.activity}>
        <div className={styles.hours} aria-hidden>
          {localHours.map((row) => (
            <span
              key={row.hour}
              style={{ height: `${Math.max(3, (row.active_ms / hourMax) * 100)}%` }}
            />
          ))}
        </div>
        <Table
          head={["Local hour", "Active time"]}
          rows={localHours.map((row) => [
            `${row.hour}`,
            hourLabel(row.hour),
            duration(row.active_ms),
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
          media.other_active_ms ? `${duration(media.other_active_ms)} in other works.` : undefined
        }
        scope={data.activity}
      >
        <Table
          head={["Work", "Active time", "Forward movement", ...actions]}
          rows={media.rows.map((row) => [
            row.media_ref,
            <WorkLink key="work" mediaRef={row.media_ref} title={row.title} />,
            duration(row.active_ms),
            movement(row.forward_word_position, row.forward_media_position_ms),
            ...filter(`work: ${row.title}`, "media", row.media_ref),
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
            row.contributor_handle,
            row.display_name,
            row.roles.join(", ") || "—",
            duration(row.active_ms),
            ...filter(`contributor: ${row.display_name}`, "contributor", row.contributor_handle),
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
              row.device_handle,
              row.label,
              duration(row.active_ms),
              row.is_current ? "Current device" : "",
              ...filter(`device: ${row.label}`, "device", row.device_handle),
            ])}
          />
        </Section>
      ) : null}
    </>
  );
}

function Sessions(props: {
  data: Stats;
  sessions: ServerList<Session>;
  more: boolean;
  correcting: boolean;
  onExclude: (row: Session) => void;
}) {
  const { sessions, correcting } = props;
  // Until the list takes up a new result, it shows that result's own first page.
  const first = props.data.activity.sessions;
  const rows = sessions.current ? sessions.items : first.items;
  const exclude = (row: Session) =>
    row.continues_before_range || row.continues_after_range ? null : (
      <ActionMenu
        label={`Actions for ${row.title}, ${row.modality}, ${shortDate(row.started_at)}`}
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
        rows={rows.map((row) => [
          [row.media_ref, row.modality, row.device.device_handle, row.started_at].join(),
          <SessionCell
            key="session"
            title={<WorkLink mediaRef={row.media_ref} title={row.title} />}
            row={row}
            action={exclude(row)}
          />,
          duration(row.active_ms),
          movement(row.forward_word_position, row.forward_media_position_ms),
        ])}
      />
      {sessions.failure !== null ? (
        <div className={styles.sessionLoadFailure} role="alert">
          <span>Sessions couldn’t load</span>
          <Button size="sm" variant="secondary" onClick={sessions.retry}>
            Retry loading sessions
          </Button>
        </div>
      ) : (
        <LoadMoreFooter
          hasMore={
            props.more &&
            (sessions.current ? !sessions.complete : first.next_cursor !== null)
          }
          loading={sessions.running === "More"}
          onLoadMore={sessions.more}
          label="Load more sessions"
        />
      )}
    </Section>
  );
}

function Exclusions(props: { data: Stats; correcting: boolean; onRestore: OnRestore }) {
  const { active_exclusions: activeExclusions } = props.data.activity;
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
          row.exclusion_handle,
          <SessionCell
            key="session"
            title={row.title}
            row={row}
            action={
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Restore ${row.title} session from ${shortDate(row.started_at)}`}
                disabled={props.correcting}
                onClick={() => props.onRestore(row)}
              >
                Restore
              </Button>
            }
          />,
          duration(row.excluded_active_ms),
        ])}
      />
    </Section>
  );
}

function Outcomes({ data }: { data: Stats }) {
  const { completion, retained_artifacts: kept } = data;
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
            row.media_ref,
            <WorkLink key="work" mediaRef={row.media_ref} title={row.title} />,
            count(row.total),
          ])}
        />
        <Table
          head={["Contributor", "Roles", "Completions"]}
          rows={completion.contributors.map((row) => [
            row.contributor_handle,
            row.display_name,
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
            ["Note blocks", count(kept.note_blocks)],
            ["Links", count(kept.neutral_links)],
          ]}
        />
      </Section>
    </>
  );
}

function YearInReading({ data, year }: { data: Stats; year: number }) {
  const {
    local_days: localDays,
    local_hours: localHours,
    longest_session: longestSession,
    media,
    timeline,
    totals,
  } = data.activity;
  const peakDay = peak(localDays);
  const peakHour = peak(localHours);
  const cover = media.rows[0]?.title;
  const longest = longestSession;
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
        <strong>{duration(totals.active_ms)}</strong>
      </header>
      <Facts
        className={styles.summary}
        facts={[
          ["Peak day", peakDay ? `${dayLabel(peakDay.date)} · ${duration(peakDay.active_ms)}` : "—"],
          [
            "Peak hour",
            peakHour ? `${hourLabel(peakHour.hour)} · ${duration(peakHour.active_ms)}` : "—",
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
              {duration(longest.active_ms)} · {longest.modality} · {shortDate(longest.started_at)}
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
  const projection = useChangeStamp("Consumption");
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
  const read = query === null ? null : `${query}\u0000${projection}\u0000${lifecycle}`;
  const resource = usePaneFreeServerValue<Committed>({
    key: read,
    stale: "",
    load: async (signal) => {
      const url = `/api/consumption/stats?${query}` as const;
      const body = await apiFetch<ApiJson<"/consumption/stats", "get">>(url, { signal });
      return { query: query!, read: read!, state, data: body.data };
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

  // A committed result carries the first page of its sessions and starts the list again;
  // continuations reuse its query, so the cursor's snapshot and scope always match.
  const sessions = usePaneFreeServerList<Session>({
    key: committed && `stats-sessions:${committed.read}`,
    stale: "",
    pageSize: 50,
    drain: false,
    active: true,
    id: (row) => [row.media_ref, row.modality, row.device.device_handle, row.started_at].join(),
    fetchPage: async (cursor, limit, signal) => {
      if (cursor === null) return committed!.data.activity.sessions;
      const params = new URLSearchParams(committed!.query);
      params.set("limit", String(limit));
      params.set("cursor", cursor);
      const url = `/api/consumption/sessions?${params}` as const;
      const body = await apiFetch<ApiJson<"/consumption/sessions", "get">>(url, { signal });
      return body.data;
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
      const init = {
        method: "POST",
        body: JSON.stringify({ ...command, client_mutation_id: clientMutationId }),
      };
      await apiFetch<ApiJson<"/consumption/activity-exclusions", "post">>(
        "/api/consumption/activity-exclusions",
        init,
      );
      mutationIds.current.delete(key);
      publishChange("Consumption");
      hud({ tone: "Success", title: success });
    } catch (error) {
      const expected = isApiError(error) && !isSameSystemApiDefect(error);
      const failure = expected ? CORRECTION_FAILURES[error.code] : undefined;
      if (!isApiError(error) || failure === undefined) return setCorrectionDefect(error);
      if (error.code === "E_UNAUTHENTICATED") handleUnauthenticatedApiError(error);
      hud({ tone: "Warning", ...failure, requestId: error.requestId });
      if (failure === STALE) publishChange("Consumption");
    } finally {
      setCorrecting(false);
    }
  };
  const exclude = ({ media_ref, modality, device, started_at, ended_at, active_ms }: Session) =>
    void correct(
      {
        kind: "Exclude",
        media_ref,
        modality,
        device_handle: device.device_handle,
        started_at,
        ended_at,
      },
      `Don’t count this ${duration(active_ms)} session?`,
      "Session excluded",
    );
  const restore = (row: Exclusion) =>
    void correct(
      { kind: "Restore", exclusion_handle: row.exclusion_handle },
      `Count this ${duration(row.excluded_active_ms)} session again?`,
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
        ? activity?.media.rows.find((row) => row.media_ref === value)?.title
        : key === "contributor"
          ? activity?.contributors.rows.find((row) => row.contributor_handle === value)?.display_name
          : activity?.devices.find((row) => row.device_handle === value)?.label;
    return label ?? `Selected ${key === "media" ? "work" : key}`;
  };
  const totals = data?.activity.totals;
  const kept = data?.retained_artifacts;
  const wholeEmpty =
    data !== null &&
    totals!.active_ms === 0 &&
    data.completion.total === 0 &&
    kept!.highlights + kept!.note_blocks + kept!.neutral_links === 0 &&
    data.activity.active_exclusions.length === 0;
  const retry = resource.status === "failed" && (
    <Button size="sm" variant="secondary" onClick={resource.refetch}>
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
      {totals?.recorded_active_ms === 0 ? (
        <section className={styles.state}>
          {data!.activity.applied_filters.length > 1 ? (
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
      ) : totals.active_ms === 0 ? (
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
              ["Observed time", duration(totals.active_ms)],
              ["Active days", count(totals.active_days)],
              [
                live ? "Current streak" : "Ending streak",
                <>
                  {count(totals.streak)} days <small>best {count(totals.longest_streak)}</small>
                </>,
              ],
              ["Sessions", count(totals.session_count)],
              [
                "Forward movement",
                totals.forward_word_position > 0 || totals.forward_media_position_ms > 0
                  ? movement(totals.forward_word_position, totals.forward_media_position_ms)
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
