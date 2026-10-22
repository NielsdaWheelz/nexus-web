"use client";

// Personal history (J8): Stats or Year in Reading for a period, anchor and filters held in the
// pane url (statsPeriod.ts). The figures are one server snapshot per read; sessions page by
// keyset under their own snapshot. The pane rereads when it becomes active, when the page
// returns to the screen and, while active, when Consumption moves. One correction at a time:
// "Don't count this session" mints the exclusion's id once per session and resends it.

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";
import Input from "@/components/ui/Input";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import PaneSection from "@/components/ui/PaneSection";
import SelectField from "@/components/ui/SelectField";
import { FeedbackNotice, FeedbackState, FeedbackStatus, useFeedback } from "@/components/feedback/Feedback";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { publishChange, useChangeStamp } from "@/lib/api/changes";
import {
  useServerValue,
  useThrowLater,
  type Visit,
} from "@/lib/api/serverState";
import {
  useServerList,
  type ListSnapshot,
  type ServerList,
} from "@/lib/api/useServerList";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import {
  usePaneIsActive,
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { useHydratedBrowserTimeZone } from "@/lib/time/browserTimeZone";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
} from "@/lib/workspace/paneReturnMemento";
import {
  PERIOD_LABEL,
  browserToday,
  periodStart,
  readStatsView,
  shiftAnchor,
  statsQuery,
  statsViewHref,
  type FilterKey,
  type StatsPeriod,
  type StatsView,
} from "./statsPeriod";
import styles from "./StatsPaneBody.module.css";

type Stats = Schema<"ConsumptionStatsOut">;
type Session = Schema<"ActivitySessionOut">;
type Exclusion = Schema<"ActiveExclusionOut">;
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

const STATS = definePaneVisitDataKey<Visit<Stats>>("Stats.Figures");
const SESSIONS =
  definePaneVisitDataKey<ListSnapshot<Session>>("Stats.Sessions");
const MODALITIES = ["Reading", "Listening", "Viewing"] as const;
const MODALITY_MS = {
  Reading: "reading_active_ms",
  Listening: "listening_active_ms",
  Viewing: "viewing_active_ms",
} as const;
const SHORT_DATE = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
} as const;
const RETRY = {
  title: "activity correction unconfirmed",
  message: "it may already be applied. refresh this view to check before retrying.",
};
const STALE = {
  title: "Activity changed before this correction",
  message: "Review the refreshed history and retry if needed.",
};
/** Copy for an expected correction failure; anything else is a defect. */
function correctionFailure(
  error: unknown,
): { title: string; message?: string } | null {
  if (!isApiError(error) || isSameSystemApiDefect(error)) return null;
  if (
    error.status === 0 ||
    error.status === 408 ||
    error.status === 429 ||
    error.status >= 500
  )
    return RETRY;
  if (error.status === 404)
    return { title: "That activity is no longer available" };
  return error.status === 400 || error.status === 409 ? STALE : null;
}

const pad = (value: number) => String(value).padStart(2, "0");
const count = (value: number) => new Intl.NumberFormat().format(value);
const hourLabel = (hour: number) => `${pad(hour)}:00`;
const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
const shortDate = (instant: string) =>
  new Date(instant).toLocaleString(undefined, SHORT_DATE);
const movement = (words: number, mediaMs: number) =>
  words > 0 ? `${count(words)} words` : duration(mediaMs);
const periodName = (view: StatsView) =>
  view.view === "year" ? (view.year ?? "This year") : PERIOD_LABEL[view.period];

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60
    ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    : `${minutes / 60}h`;
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

function Facts(props: {
  className: string;
  label?: string;
  facts: [string, ReactNode][];
}) {
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
    <PaneSection
      className={styles.section}
      title={title}
      description={description}
    >
      {children}
      {scope ? (
        <p className={styles.scope}>
          <strong>Applies:</strong> {scope.applied_filters.join(", ")}.
          {notApplied ? (
            <>
              {" "}
              <strong>Not applied:</strong> {notApplied}.
            </>
          ) : null}
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
              {label === "Actions" ? (
                <span className="sr-only">Actions</span>
              ) : (
                label
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(([key, header, ...cells]) => (
          <tr key={key}>
            <th scope="row">{header}</th>
            {cells.map((cell, index) => (
              <td key={index}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WorkLink({ mediaId, title }: { mediaId: string; title: string }) {
  const paneRuntime = usePaneRuntime();
  const target = { href: `/media/${mediaId}`, labelHint: title };
  return (
    <a href={target.href} className={styles.rowLink} data-workspace-rich-target="true"
      onClick={event => activateTargetLink({ event, runtime: paneRuntime, target })}
      onKeyDown={event => activateTargetLink({ event, runtime: paneRuntime, target })}>
      {title}
    </a>
  );
}

/** A session or exclusion: its work, "modality · device · start", and its one correction. */
function SessionCell(props: {
  title: ReactNode;
  row: Session | Exclusion;
  action: ReactNode;
}) {
  const { row } = props;
  const when = `${row.modality} · ${row.device.label} · ${shortDate(row.started_at)}`;
  const clipped =
    "continues_before_range" in row &&
    (row.continues_before_range || row.continues_after_range);
  return (
    <div className={styles.sessionCell}>
      <div>
        {props.title}
        <span className={styles.muted}>
          {clipped ? `${when} · continues beyond range` : when}
        </span>
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
      <svg
        className={styles.chart}
        aria-hidden
        viewBox="0 0 320 86"
        preserveAspectRatio="none"
      >
        {rows.map((row, index) => {
          let top = 86;
          return (
            <g key={row.start}>
              {MODALITIES.map((modality) => {
                const height = (row[MODALITY_MS[modality]] / max) * 82;
                top -= height;
                const bar = {
                  x: index * width,
                  y: top,
                  width: Math.max(1, width - 1),
                  height,
                };
                return (
                  <rect
                    key={modality}
                    className={styles[`bar${modality}`]}
                    {...bar}
                  />
                );
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
            <span className={styles.muted}>
              ({utcOffset(row.utc_offset_minutes)})
            </span>
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
          rows={localDays.map((row) => [
            row.date,
            dayLabel(row.date),
            duration(row.active_ms),
          ])}
        />
      </Section>
      <Section
        title="Time of day"
        description="Active time by local hour."
        scope={data.activity}
      >
        <div className={styles.hours} aria-hidden>
          {localHours.map((row) => (
            <span
              key={row.hour}
              style={{
                height: `${Math.max(3, (row.active_ms / hourMax) * 100)}%`,
              }}
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
          media.other_active_ms
            ? `${duration(media.other_active_ms)} in other works.`
            : undefined
        }
        scope={data.activity}
      >
        <Table
          head={["Work", "Active time", "Forward movement", ...actions]}
          rows={media.rows.map((row) => [
            row.media_id,
            <WorkLink key="work" mediaId={row.media_id} title={row.title} />,
            duration(row.active_ms),
            movement(row.forward_word_position, row.forward_media_position_ms),
            ...filter(`work: ${row.title}`, "media", row.media_id),
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
            ...filter(
              `contributor: ${row.display_name}`,
              "contributor",
              row.contributor_handle,
            ),
          ])}
        />
      </Section>
      {onFilter ? (
        <Section
          title="Devices"
          description="Devices you read, listened or watched on."
          scope={data.activity}
        >
          <Table
            head={["Device", "Active time", "Current", ...actions]}
            rows={devices.map((row) => [
              row.device_id,
              row.label,
              duration(row.active_ms),
              row.is_current ? "Current device" : "",
              ...filter(`device: ${row.label}`, "device", row.device_id),
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
  correcting: boolean;
  onExclude: (row: Session) => void;
}) {
  const { sessions, correcting } = props;
  const section = useRef<HTMLDivElement>(null);
  const exclude = (row: Session) =>
    row.continues_before_range || row.continues_after_range ? null : (
      <ActionMenu
        label={`more actions for ${row.title}, ${row.modality}, ${shortDate(row.started_at)}`}
        triggerDisabled={correcting}
        triggerDisabledReason="Another activity correction is in progress"
        source={{ kind: "Immediate", subjectKey: `activity-session:${sessionKey(row)}`, title: `${row.title}, ${row.modality}, ${shortDate(row.started_at)}`, content: { sections: [{ id: "Session", label: null, options: [
          {
            kind: "command",
            id: "Consumption.Activity.ExcludeSession",
            label: "Don’t count this session",
            onSelect: () => props.onExclude(row),
          },
        ] }] } }}
      />
    );
  return (
    <Section
      title="Sessions"
      description="Server-derived sessions; time is clipped to this range."
      scope={props.data.activity}
    >
      <div ref={section} tabIndex={-1} role="group" aria-label="sessions">
        <Table
          head={["Session", "Active time", "Movement"]}
          rows={sessions.items.map((row) => [
            sessionKey(row),
            <SessionCell
              key="session"
              title={<WorkLink mediaId={row.media_id} title={row.title} />}
              row={row}
              action={exclude(row)}
            />,
            duration(row.active_ms),
            movement(row.forward_word_position, row.forward_media_position_ms),
          ])}
        />
        {sessions.failure !== null && sessions.failure.op !== "More" ? (
          <FeedbackNotice
            content={{ tone: "Warning", title: sessions.current ? "sessions couldn’t refresh" : "sessions couldn’t load", requestId: sessions.failure.error.requestId }}
            announcement="Polite"
            actions={[{ label: "retry sessions", onClick: sessions.retry, busy: sessions.running !== null }]}
          />
        ) : null}
        <CollectionExhaustionNotice list={sessions} unit={{ singular: "session", plural: "sessions" }} returnFocus={() => section.current} />
      </div>
    </Section>
  );
}

function Exclusions(props: {
  data: Stats;
  correcting: boolean;
  onRestore: OnRestore;
}) {
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
          row.id,
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
            row.media_id,
            <WorkLink key="work" mediaId={row.media_id} title={row.title} />,
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

function YearInReading({ data, year }: { data: Stats; year: number | string }) {
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
          [
            "Peak day",
            peakDay
              ? `${dayLabel(peakDay.date)} · ${duration(peakDay.active_ms)}`
              : "—",
          ],
          [
            "Peak hour",
            peakHour
              ? `${hourLabel(peakHour.hour)} · ${duration(peakHour.active_ms)}`
              : "—",
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
            duration(
              timeline.reduce(
                (sum, row) => sum + row[MODALITY_MS[modality]],
                0,
              ),
            ),
          ])}
        />
      </Section>
      {longest ? (
        <Section title="Longest session">
          <p className={styles.longest}>
            <strong>{longest.title}</strong>
            <span>
              {duration(longest.active_ms)} · {longest.modality} ·{" "}
              {shortDate(longest.started_at)}
            </span>
          </p>
        </Section>
      ) : null}
      <Breakdowns data={data} />
      <Outcomes data={data} />
    </div>
  );
}

const sessionKey = (row: Session) =>
  [
    row.media_id,
    row.modality,
    row.device.device_id,
    row.started_at,
    row.ended_at,
  ].join();

function Controls(props: {
  view: StatsView;
  update: (next: Partial<StatsView>) => void;
  onFilter: OnFilter;
  chipLabel: (key: "media" | "contributor" | "device", value: string) => string;
}) {
  const { view, update, onFilter } = props;
  const today = browserToday();
  const thisYear = Number(today.slice(0, 4));
  const year = view.year ?? thisYear;
  const anchor = view.anchor ?? today;
  const yearView = view.view === "year";
  const shift = (amount: number) => shiftAnchor(anchor, view.period, amount);
  const move = (amount: number) =>
    update(yearView ? { year: year + amount } : { anchor: shift(amount) });
  const canGoNext = yearView
    ? year < thisYear
    : periodStart(shift(1), view.period) <= periodStart(today, view.period);
  const chips = (["media", "contributor", "device"] as const).flatMap((key) => {
    const value = view.filters[key];
    return value ? [[key, value] as const] : [];
  });
  const pressed = (name: StatsView["view"]) =>
    ({
      size: "sm",
      variant: view.view === name ? "primary" : "secondary",
      "aria-pressed": view.view === name,
    }) as const;
  return (
    <div className={styles.controls}>
      <div role="group" aria-label="Stats view">
        <Button
          {...pressed("stats")}
          onClick={() => update({ view: "stats", period: "day" })}
        >
          Stats
        </Button>
        <Button
          {...pressed("year")}
          onClick={() => update({ view: "year", period: "year" })}
        >
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
            value={year}
            onChange={(event) =>
              update({ year: Number(event.target.value) || null })
            }
          />
        </label>
      ) : (
        <>
          <SelectField
            layout="Stacked"
            label="Period"
            size="sm"
            value={view.period}
            onChange={(event) =>
              update({ period: event.target.value as StatsPeriod })
            }
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
              value={anchor}
              onChange={(event) =>
                update({ anchor: event.target.value || null })
              }
            />
          </label>
        </>
      )}
      {yearView || view.period !== "all" ? (
        <div
          role="group"
          aria-label={yearView ? "Year navigation" : "Date navigation"}
        >
          <Button size="sm" variant="secondary" onClick={() => move(-1)}>
            Previous
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => update(yearView ? { year: null } : { anchor: null })}
          >
            {yearView ? "This year" : "Today"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => move(1)}
            disabled={!canGoNext}
          >
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
            value={view.filters.modality ?? ""}
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
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const feedback = useFeedback();
  const fail = useThrowLater();
  const timeZone = useHydratedBrowserTimeZone();
  const isActive = usePaneIsActive();
  const router = usePaneRouter();
  const view = readStatsView(usePaneSearchParams());
  const refresh = useRefreshStamp(isActive, 0);
  const consumption = useChangeStamp("Consumption");
  const [correcting, setCorrecting] = useState(false);
  const exclusionIds = useRef(new Map<string, string>());
  const update = (next: Partial<StatsView>) =>
    router.replace(statsViewHref({ ...view, ...next }));

  const query = timeZone ? statsQuery(view, timeZone).toString() : null;
  // Progress saves move Consumption every few seconds: follow them only while visible here.
  // The stamp seen last while active stands while inactive, so leaving the pane reads nothing.
  const followed = useRef(consumption);
  if (isActive) followed.current = consumption;
  const stale = `${refresh}:${followed.current}`;
  const stats = useServerValue({
    key: query,
    stale,
    visit: STATS,
    load: async (signal) =>
      (
        await apiFetch<ApiJson<"/consumption/stats", "get">>(
          `/api/consumption/stats?${query}`,
          { signal },
        )
      ).data,
  });
  const sessions = useServerList<Session>({
    key: query,
    stale,
    pageSize: 50,
    active: isActive && view.view !== "year" && stats.status === "ready" && stats.data.activity.totals.active_ms > 0,
    visit: SESSIONS,
    id: sessionKey,
    fetchPage: async (cursor, limit, signal) => {
      const params = new URLSearchParams(query!);
      params.set("limit", `${limit}`);
      if (cursor !== null) params.set("cursor", cursor);
      const url = `/api/consumption/sessions?${params}` as const;
      return (
        await apiFetch<ApiJson<"/consumption/sessions", "get">>(url, { signal })
      ).data;
    },
  });
  // A new view keeps the prior one's figures on screen until its own arrive.
  const shown = useRef<{ view: StatsView; data: Stats } | null>(null);
  if (stats.status === "ready") shown.current = { view, data: stats.data };
  const data = shown.current?.data ?? null;
  const updating = stats.status === "loading" && data !== null;
  const initialLoading = data === null && stats.status === "loading";
  usePaneReturnReady(!initialLoading);

  const correct = async (
    send: () => Promise<void>,
    confirmation: string,
    success: string,
  ) => {
    if (!mounted.current || correcting || !window.confirm(confirmation)) return;
    setCorrecting(true);
    try {
      await send();
      if (!mounted.current) return;
      publishChange("Consumption");
      feedback.receipt({ tone: "Success", title: success });
    } catch (error) {
      if (!mounted.current) return;
      if (handleUnauthenticatedApiError(error)) return;
      const failure = correctionFailure(error);
      if (failure === null) return fail({ error });
      feedback.offer({ key: "consumption-activity-correction", announcement: "Polite", content: { tone: "Warning", ...failure, requestId: isApiError(error) ? error.requestId : undefined } });
      if (failure === STALE) publishChange("Consumption");
    } finally {
      if (mounted.current) setCorrecting(false);
    }
  };
  const exclude = (row: Session) => {
    const key = sessionKey(row);
    const id = exclusionIds.current.get(key) ?? crypto.randomUUID();
    exclusionIds.current.set(key, id);
    const body = {
      media_id: row.media_id,
      modality: row.modality,
      device_id: row.device.device_id,
      started_at: row.started_at,
      ended_at: row.ended_at,
    };
    // One id per attempt at this session, resent until it lands.
    const send = async () => {
      await apiFetch<void>(`/api/consumption/exclusions/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      exclusionIds.current.delete(key);
    };
    void correct(
      send,
      `Don’t count this ${duration(row.active_ms)} session?`,
      "Session excluded",
    );
  };
  const restore = (row: Exclusion) =>
    void correct(
      () =>
        apiFetch<void>(`/api/consumption/exclusions/${row.id}`, {
          method: "DELETE",
        }),
      `Count this ${duration(row.excluded_active_ms)} session again?`,
      "Session restored",
    );

  const yearView = view.view === "year";
  const today = browserToday();
  const live =
    view.period === "all" ||
    periodStart(view.anchor ?? today, view.period) ===
      periodStart(today, view.period);
  const setFilter = (key: FilterKey, value: string) =>
    update({ filters: { ...view.filters, [key]: value || undefined } });
  const chipLabel = (
    key: "media" | "contributor" | "device",
    value: string,
  ) => {
    const activity = data?.activity;
    const label =
      key === "media"
        ? activity?.media.rows.find((row) => row.media_id === value)?.title
        : key === "contributor"
          ? activity?.contributors.rows.find(
              (row) => row.contributor_handle === value,
            )?.display_name
          : activity?.devices.find((row) => row.device_id === value)?.label;
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
  const failure = stats.status === "failed" || stats.status === "ready" ? stats.error : null;
  const retryActions = [{
    label: "retry statistics", onClick: stats.refetch,
    busy: stats.status === "failed" ? stats.retrying : stats.status === "ready" && stats.refreshing,
  }] as const;

  return (
    <main className={styles.pane} aria-busy={updating || initialLoading}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>
            {yearView ? "A factual annual record" : "Consumption activity"}
          </p>
          <p className={styles.timeZone}>
            Local time · {timeZone ?? "detecting your time zone"}
          </p>
        </div>
        <Controls
          view={view}
          update={update}
          onFilter={setFilter}
          chipLabel={chipLabel}
        />
      </header>
      {updating && shown.current ? (
        <FeedbackStatus content={{ tone: "Neutral", title: `updating ${periodName(view)}`, message: `showing the prior ${periodName(shown.current.view)} result until it arrives.` }} announcement="Polite" />
      ) : null}
      {initialLoading ? (
        <div className={styles.loading} aria-label="Loading statistics" />
      ) : null}
      {failure !== null && data === null ? (
        <FeedbackState content={{ tone: "Warning", title: "statistics couldn’t load", requestId: failure.requestId }} announcement="Polite" actions={retryActions} />
      ) : null}
      {failure !== null && data !== null ? (
        <FeedbackNotice content={{ tone: "Warning", title: "statistics couldn’t refresh", message: "showing the last loaded result.", requestId: failure.requestId }} announcement="Polite" actions={retryActions} />
      ) : null}
      {totals?.recorded_active_ms === 0 ? (
        <FeedbackState content={data!.activity.applied_filters.length > 1
          ? { tone: "Neutral", title: "no activity matches this view", message: "try a broader period." }
          : { tone: "Neutral", title: "no observed activity yet", message: "reading, listening and video activity appears here when recorded." }} announcement="None" />
      ) : null}
      {data === null || totals === undefined || wholeEmpty ? null : yearView ? (
        <YearInReading data={data} year={view.year ?? today.slice(0, 4)} />
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
                  {count(totals.streak)} days{" "}
                  <small>best {count(totals.longest_streak)}</small>
                </>,
              ],
              ["Sessions", count(totals.session_count)],
              [
                "Forward movement",
                totals.forward_word_position > 0 ||
                totals.forward_media_position_ms > 0
                  ? movement(
                      totals.forward_word_position,
                      totals.forward_media_position_ms,
                    )
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
