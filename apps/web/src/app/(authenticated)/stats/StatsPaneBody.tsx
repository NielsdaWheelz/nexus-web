"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import { useResource } from "@/lib/api/useResource";
import {
  decodeConsumptionStats,
  decodeActivitySessionPage,
  decodeStatsUrlState,
  encodeStatsUrlState,
  statsPath,
  statsSessionsPath,
  type ActivityModality,
  type ConsumptionStats,
  type StatsPeriod,
  type StatsSession,
  type StatsUrlState,
} from "@/lib/consumption/statsContract";
import {
  requirePaneRuntime,
  usePaneReturnReady,
  usePaneRuntime,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import { useHydratedBrowserTimeZone } from "@/lib/time/browserTimeZone";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import styles from "./StatsPaneBody.module.css";

const PERIOD_LABEL: Record<StatsPeriod, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
  all: "All time",
};
const MODALITIES: ActivityModality[] = ["Reading", "Listening", "Viewing"];

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
}

function number(value: number): string {
  return new Intl.NumberFormat().format(value);
}
function dateLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}
function shortDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
function utcOffsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}
function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function localDateIn(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function civilDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}
function formatCivilDate(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}
function shiftAnchor(
  anchor: string,
  period: StatsPeriod,
  amount: number,
): string {
  const date = civilDate(anchor);
  if (period === "day") date.setUTCDate(date.getUTCDate() + amount);
  else if (period === "week") date.setUTCDate(date.getUTCDate() + amount * 7);
  else if (period === "month") date.setUTCMonth(date.getUTCMonth() + amount, 1);
  else if (period === "year")
    date.setUTCFullYear(date.getUTCFullYear() + amount, 0, 1);
  return formatCivilDate(date);
}
function periodStart(anchor: string, period: StatsPeriod): string {
  if (period === "all") return "1970-01-01";
  const date = civilDate(anchor);
  if (period === "week") {
    const weekday = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() - weekday + 1);
  } else if (period === "month") {
    date.setUTCDate(1);
  } else if (period === "year") {
    date.setUTCMonth(0, 1);
  }
  return formatCivilDate(date);
}
function isLivePeriod(state: StatsUrlState): boolean {
  if (state.view !== "stats") return false;
  if (state.period === "all") return true;
  const today = localToday();
  return (
    periodStart(state.anchor, state.period) === periodStart(today, state.period)
  );
}
function movement(stats: ConsumptionStats): string {
  const words = stats.activity.totals.forwardWordPosition;
  const media = stats.activity.totals.forwardMediaPositionMs;
  return words > 0
    ? `${number(words)} words`
    : media > 0
      ? duration(media)
      : "—";
}
function mediaPath(mediaRef: string): string | null {
  const parsed = parseResourceRef(mediaRef);
  return parsed?.scheme === "media" ? `/media/${parsed.id}` : null;
}
function selectedFilterLabel(
  data: ConsumptionStats | null,
  key: "media" | "contributor" | "device",
  value: string,
): string {
  if (key === "media")
    return (
      data?.activity.media.rows.find((row) => row.mediaRef === value)?.title ??
      "Selected work"
    );
  if (key === "contributor")
    return (
      data?.activity.contributors.rows.find(
        (row) => row.contributorHandle === value,
      )?.displayName ?? "Selected contributor"
    );
  return (
    data?.activity.devices.find((row) => row.deviceHandle === value)?.label ??
    "Selected device"
  );
}

function Section({
  title,
  detail,
  scope,
  children,
}: {
  title: string;
  detail?: string;
  scope?: { appliedFilters: string[]; inapplicableFilters: string[] };
  children: React.ReactNode;
}) {
  return (
    <section
      className={styles.section}
      aria-labelledby={`${title.replaceAll(" ", "-").toLowerCase()}-title`}
    >
      <div className={styles.sectionHead}>
        <div>
          <h2 id={`${title.replaceAll(" ", "-").toLowerCase()}-title`}>
            {title}
          </h2>
          {detail ? <p>{detail}</p> : null}
        </div>
      </div>
      {children}
      {scope ? (
        <p className={styles.scope}>
          <strong>Applies:</strong> {scope.appliedFilters.join(", ") || "none"}.{" "}
          {scope.inapplicableFilters.length ? (
            <>
              <strong>Not applied:</strong>{" "}
              {scope.inapplicableFilters.join(", ")}.
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

function Timeline({ data }: { data: ConsumptionStats }) {
  const max = Math.max(...data.activity.timeline.map((row) => row.activeMs), 1);
  return (
    <Section
      title="Activity over time"
      detail="Observed active time, in your local time."
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
        data-testid="activity-timeline-chart"
        className={styles.lineChart}
        aria-hidden="true"
        viewBox="0 0 320 86"
        preserveAspectRatio="none"
      >
        <defs>
          <pattern
            id="stats-reading"
            width="5"
            height="5"
            patternUnits="userSpaceOnUse"
          >
            <rect width="5" height="5" fill="var(--accent)" />
          </pattern>
          <pattern
            id="stats-listening"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
          >
            <rect width="6" height="6" fill="var(--info)" />
            <path d="M0,6 L6,0" stroke="var(--surface-1)" strokeWidth="1" />
          </pattern>
          <pattern
            id="stats-viewing"
            width="5"
            height="5"
            patternUnits="userSpaceOnUse"
          >
            <rect width="5" height="5" fill="var(--warning)" />
            <circle cx="2.5" cy="2.5" r=".8" fill="var(--surface-1)" />
          </pattern>
        </defs>
        {data.activity.timeline.map((row, index) => {
          const x = index * (320 / Math.max(data.activity.timeline.length, 1));
          const width = Math.max(
            1,
            320 / Math.max(data.activity.timeline.length, 1) - 1,
          );
          const reading = (row.readingActiveMs / max) * 82;
          const listening = (row.listeningActiveMs / max) * 82;
          const viewing = (row.viewingActiveMs / max) * 82;
          return (
            <g key={row.start}>
              <rect
                x={x}
                y={86 - reading}
                width={width}
                height={reading}
                fill="url(#stats-reading)"
              />
              <rect
                x={x}
                y={86 - reading - listening}
                width={width}
                height={listening}
                fill="url(#stats-listening)"
              />
              <rect
                x={x}
                y={86 - reading - listening - viewing}
                width={width}
                height={viewing}
                fill="url(#stats-viewing)"
              />
            </g>
          );
        })}
      </svg>
      <table>
        <thead>
          <tr>
            <th scope="col">Local time</th>
            {MODALITIES.map((item) => (
              <th key={item} scope="col">
                {item}
              </th>
            ))}
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {data.activity.timeline.map((row) => (
            <tr key={`${row.start}-${row.end}`}>
              <th scope="row">
                {row.localLabel}{" "}
                <span className={styles.muted}>
                  ({utcOffsetLabel(row.utcOffsetMinutes)})
                </span>
              </th>
              <td>{duration(row.readingActiveMs)}</td>
              <td>{duration(row.listeningActiveMs)}</td>
              <td>{duration(row.viewingActiveMs)}</td>
              <td>{duration(row.activeMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function Heatmap({ data }: { data: ConsumptionStats }) {
  const max = Math.max(
    ...data.activity.localDays.map((row) => row.activeMs),
    1,
  );
  return (
    <Section
      title="Active local days"
      detail="Each square is one local calendar day."
      scope={data.activity}
    >
      <div className={styles.heatmap} aria-hidden="true">
        {data.activity.localDays.map((row) => (
          <span
            key={row.date}
            style={{ opacity: 0.15 + (row.activeMs / max) * 0.85 }}
            title={`${dateLabel(row.date)}: ${duration(row.activeMs)}`}
          />
        ))}
      </div>
      <table>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Active time</th>
          </tr>
        </thead>
        <tbody>
          {data.activity.localDays.map((row) => (
            <tr key={row.date}>
              <th scope="row">{dateLabel(row.date)}</th>
              <td>{duration(row.activeMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function Hours({ data }: { data: ConsumptionStats }) {
  const max = Math.max(
    ...data.activity.localHours.map((row) => row.activeMs),
    1,
  );
  return (
    <Section
      title="Time of day"
      detail="Active time by local hour."
      scope={data.activity}
    >
      <div className={styles.hourChart} aria-hidden="true">
        {data.activity.localHours.map((row) => (
          <span
            key={row.hour}
            style={{ height: `${Math.max(3, (row.activeMs / max) * 100)}%` }}
          />
        ))}
      </div>
      <table>
        <thead>
          <tr>
            <th scope="col">Local hour</th>
            <th scope="col">Active time</th>
          </tr>
        </thead>
        <tbody>
          {data.activity.localHours.map((row) => (
            <tr key={row.hour}>
              <th scope="row">{String(row.hour).padStart(2, "0")}:00</th>
              <td>{duration(row.activeMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function WorkTables({
  data,
  includeDevices = true,
  onFilter,
}: {
  data: ConsumptionStats;
  includeDevices?: boolean;
  onFilter?: (key: "media" | "contributor" | "device", value: string) => void;
}) {
  const paneRuntime = usePaneRuntime();
  return (
    <>
      <Section
        title="Top works"
        detail={
          data.activity.media.otherActiveMs
            ? `${duration(data.activity.media.otherActiveMs)} in other works.`
            : undefined
        }
        scope={data.activity}
      >
        <table>
          <thead>
            <tr>
              <th scope="col">Work</th>
              <th scope="col">Active time</th>
              <th scope="col">Forward movement</th>
              {onFilter ? (
                <th scope="col">
                  <span className={styles.srOnly}>Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {data.activity.media.rows.map((row) => {
              const href = mediaPath(row.mediaRef);
              return (
                <tr key={row.mediaRef}>
                  <th scope="row">
                    {href ? (
                      <button
                        type="button"
                        className={styles.rowLink}
                        onClick={(event) =>
                          requirePaneRuntime(
                            paneRuntime,
                            "Stats work target activation",
                          ).activateTarget({
                            target: { href, labelHint: row.title },
                            disposition:
                              workspaceTargetClickIntent(event).disposition,
                          })
                        }
                      >
                        {row.title}
                      </button>
                    ) : (
                      row.title
                    )}
                  </th>
                  <td>{duration(row.activeMs)}</td>
                  <td>
                    {row.forwardWordPosition
                      ? `${number(row.forwardWordPosition)} words`
                      : duration(row.forwardMediaPositionMs)}
                  </td>
                  {onFilter ? (
                    <td>
                      <button
                        type="button"
                        className={styles.filterAction}
                        onClick={() => onFilter("media", row.mediaRef)}
                        aria-label={`Filter work: ${row.title}`}
                      >
                        Filter
                      </button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
      <Section
        title="Contributors"
        detail="Each credited person is fully credited; totals are not additive."
        scope={data.activity}
      >
        <table>
          <thead>
            <tr>
              <th scope="col">Contributor</th>
              <th scope="col">Roles</th>
              <th scope="col">Active time</th>
              {onFilter ? (
                <th scope="col">
                  <span className={styles.srOnly}>Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {data.activity.contributors.rows.map((row) => (
              <tr key={row.contributorHandle}>
                <th scope="row">{row.displayName}</th>
                <td>{row.roles?.join(", ") || "—"}</td>
                <td>{duration(row.activeMs)}</td>
                {onFilter ? (
                  <td>
                    <button
                      type="button"
                      className={styles.filterAction}
                      onClick={() =>
                        onFilter("contributor", row.contributorHandle)
                      }
                      aria-label={`Filter contributor: ${row.displayName}`}
                    >
                      Filter
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {includeDevices ? (
        <Section
          title="Devices"
          detail="A sealed device label, never a raw device identifier."
          scope={data.activity}
        >
          <table>
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">Active time</th>
                <th scope="col">Current</th>
                {onFilter ? (
                  <th scope="col">
                    <span className={styles.srOnly}>Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {data.activity.devices.map((row) => (
                <tr key={row.deviceHandle}>
                  <th scope="row">{row.label}</th>
                  <td>{duration(row.activeMs)}</td>
                  <td>{row.isCurrent ? "Current device" : ""}</td>
                  {onFilter ? (
                    <td>
                      <button
                        type="button"
                        className={styles.filterAction}
                        onClick={() => onFilter("device", row.deviceHandle)}
                        aria-label={`Filter device: ${row.label}`}
                      >
                        Filter
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ) : null}
    </>
  );
}

function SessionRows({
  rows,
  nextCursor,
  loadingMore,
  onLoadMore,
}: {
  rows: StatsSession[];
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const paneRuntime = usePaneRuntime();
  return (
    <>
      <table>
        <thead>
          <tr>
            <th scope="col">Session</th>
            <th scope="col">Active time</th>
            <th scope="col">Movement</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = mediaPath(row.mediaRef);
            return (
              <tr key={`${row.mediaRef}-${row.startedAt}`}>
                <th scope="row">
                  {href ? (
                    <button
                      type="button"
                      className={styles.rowLink}
                      onClick={(event) =>
                        requirePaneRuntime(
                          paneRuntime,
                          "Stats session target activation",
                        ).activateTarget({
                          target: { href, labelHint: row.title },
                          disposition:
                            workspaceTargetClickIntent(event).disposition,
                        })
                      }
                    >
                      {row.title}
                    </button>
                  ) : (
                    row.title
                  )}
                  <span className={styles.muted}>
                    {row.modality} · {shortDate(row.startedAt)}
                    {row.continuesBeforeRange || row.continuesAfterRange
                      ? " · continues beyond range"
                      : ""}
                  </span>
                </th>
                <td>{duration(row.activeMs)}</td>
                <td>
                  {row.forwardWordPosition
                    ? `${number(row.forwardWordPosition)} words`
                    : duration(row.forwardMediaPositionMs)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {nextCursor ? (
        <button
          className={styles.loadMore}
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
        >
          {loadingMore ? "Loading sessions…" : "Load more sessions"}
        </button>
      ) : null}
    </>
  );
}

function CreatedAndKept({ data }: { data: ConsumptionStats }) {
  return (
    <Section
      title="Created and kept"
      detail="Period-wide artifacts; consumption filters do not apply."
      scope={data.retainedArtifacts}
    >
      <dl className={styles.artifacts}>
        <div>
          <dt>Highlights</dt>
          <dd>{number(data.retainedArtifacts.highlights)}</dd>
        </div>
        <div>
          <dt>Note blocks</dt>
          <dd>{number(data.retainedArtifacts.noteBlocks)}</dd>
        </div>
        <div>
          <dt>Links</dt>
          <dd>{number(data.retainedArtifacts.neutralLinks)}</dd>
        </div>
      </dl>
    </Section>
  );
}

function Completions({ data }: { data: ConsumptionStats }) {
  const paneRuntime = usePaneRuntime();
  return (
    <Section
      title="Completions"
      detail="Completion facts recorded in this selected period."
      scope={data.completion}
    >
      <p className={styles.completionTotal}>
        <strong>{number(data.completion.total)}</strong> completed
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Work</th>
            <th scope="col">Completions</th>
          </tr>
        </thead>
        <tbody>
          {data.completion.media.map((row) => {
            const href = mediaPath(row.mediaRef);
            return (
              <tr key={row.mediaRef}>
                <th scope="row">
                  {href ? (
                    <button
                      type="button"
                      className={styles.rowLink}
                      onClick={(event) =>
                        requirePaneRuntime(
                          paneRuntime,
                          "Stats completion target activation",
                        ).activateTarget({
                          target: { href, labelHint: row.title },
                          disposition:
                            workspaceTargetClickIntent(event).disposition,
                        })
                      }
                    >
                      {row.title}
                    </button>
                  ) : (
                    row.title
                  )}
                </th>
                <td>{number(row.total)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <table>
        <thead>
          <tr>
            <th scope="col">Contributor</th>
            <th scope="col">Roles</th>
            <th scope="col">Completions</th>
          </tr>
        </thead>
        <tbody>
          {data.completion.contributors.map((row) => (
            <tr key={row.contributorHandle}>
              <th scope="row">{row.displayName}</th>
              <td>{row.roles.join(", ") || "—"}</td>
              <td>{number(row.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function YearReading({ data, year }: { data: ConsumptionStats; year: number }) {
  const peakDay = [...data.activity.localDays].sort(
    (a, b) => b.activeMs - a.activeMs,
  )[0];
  const peakHourCandidate = [...data.activity.localHours].sort(
    (a, b) => b.activeMs - a.activeMs,
  )[0];
  const peakHour =
    peakHourCandidate && peakHourCandidate.activeMs > 0
      ? peakHourCandidate
      : undefined;
  const longest =
    data.activity.longestSession.kind === "Present"
      ? data.activity.longestSession.value
      : null;
  return (
    <div className={styles.yearMode}>
      <header className={styles.yearHero}>
        <p>Year in Reading</p>
        <div
          className={styles.cover}
          aria-label={
            data.activity.media.rows[0]
              ? `Cover for ${data.activity.media.rows[0].title}`
              : "No cover available"
          }
        >
          {data.activity.media.rows[0]?.title.slice(0, 1) ?? ""}
        </div>
        <h1>{year}</h1>
        <strong>{duration(data.activity.totals.activeMs)}</strong>
        <span>observed active time</span>
      </header>
      <div className={styles.yearFacts}>
        <div>
          <span>Peak day</span>
          <strong>
            {peakDay
              ? `${dateLabel(peakDay.date)} · ${duration(peakDay.activeMs)}`
              : "—"}
          </strong>
        </div>
        <div>
          <span>Peak hour</span>
          <strong>
            {peakHour
              ? `${String(peakHour.hour).padStart(2, "0")}:00 · ${duration(peakHour.activeMs)}`
              : "—"}
          </strong>
        </div>
        <div>
          <span>Completions</span>
          <strong>{number(data.completion.total)}</strong>
        </div>
      </div>
      <Timeline data={data} />
      <Section title="Modality composition">
        <table>
          <thead>
            <tr>
              <th scope="col">Mode</th>
              <th scope="col">Active time</th>
            </tr>
          </thead>
          <tbody>
            {MODALITIES.map((mode) => (
              <tr key={mode}>
                <th scope="row">{mode}</th>
                <td>
                  {duration(
                    data.activity.timeline.reduce(
                      (total, row) =>
                        total +
                        row[
                          `${mode.toLowerCase()}ActiveMs` as "readingActiveMs"
                        ],
                      0,
                    ),
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {longest ? (
        <Section title="Longest session">
          <p className={styles.longest}>
            <strong>{longest.title}</strong>
            <span>
              {duration(longest.activeMs)} · {longest.modality} ·{" "}
              {shortDate(longest.startedAt)}
            </span>
          </p>
        </Section>
      ) : null}
      <WorkTables data={data} includeDevices={false} />
      <Completions data={data} />
      <CreatedAndKept data={data} />
    </div>
  );
}

export default function StatsPaneBody() {
  const hydratedTimeZone = useHydratedBrowserTimeZone();
  const codec = useMemo(
    () => ({
      basePath: "/stats",
      decode: decodeStatsUrlState,
      encode: encodeStatsUrlState,
    }),
    [],
  );
  const { state, setState } = usePaneUrlState<StatsUrlState>(codec);
  const paneSearchParams = usePaneSearchParams();
  const rawSearch = paneSearchParams.toString();
  const canonicalSearch = encodeStatsUrlState(
    state,
    paneSearchParams,
  ).toString();
  const urlIsCanonical = rawSearch === canonicalSearch;
  useEffect(() => {
    if (hydratedTimeZone && !urlIsCanonical) setState(state);
  }, [hydratedTimeZone, setState, state, urlIsCanonical]);
  const path =
    hydratedTimeZone && urlIsCanonical
      ? statsPath(state, hydratedTimeZone)
      : null;
  const resource = useResource<{ path: string; data: ConsumptionStats }>({
    cacheKey: path,
    load: async (signal) => {
      const requestPath = path as ApiPath;
      return {
        path: requestPath,
        data: decodeConsumptionStats(
          await apiFetch<unknown>(requestPath, { signal }),
        ),
      };
    },
  });
  const [extraSessions, setExtraSessions] = useState<StatsSession[]>([]);
  const [nextSessionCursor, setNextSessionCursor] = useState<string | null>(
    null,
  );
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);
  useEffect(() => {
    setExtraSessions([]);
    setNextSessionCursor(null);
  }, [path]);
  const previous = useRef<{
    data: ConsumptionStats;
    state: StatsUrlState;
  } | null>(null);
  const currentData =
    resource.status === "ready" && resource.data.path === path
      ? resource.data.data
      : null;
  if (currentData !== null) previous.current = { data: currentData, state };
  const committed =
    currentData !== null ? { data: currentData, state } : previous.current;
  const data = committed?.data ?? null;
  const fetchingCurrent =
    path !== null &&
    (resource.status === "loading" ||
      (resource.status === "ready" && resource.data.path !== path));
  const initialLoading = path === null || (fetchingCurrent && data === null);
  const updating = fetchingCurrent && data !== null;
  usePaneReturnReady(!initialLoading);
  const noActivity = data !== null && data.activity.totals.activeMs === 0;
  const wholeEmpty =
    data !== null &&
    noActivity &&
    data.completion.total === 0 &&
    data.retainedArtifacts.highlights === 0 &&
    data.retainedArtifacts.noteBlocks === 0 &&
    data.retainedArtifacts.neutralLinks === 0;
  const filterEmpty =
    data !== null &&
    data.activity.appliedFilters.some((filter) => filter !== "time");
  const update = useCallback(
    (next: Partial<StatsUrlState>) => setState({ ...state, ...next }),
    [setState, state],
  );
  const anchor = state.view === "year" ? `${state.year}-01-01` : state.anchor;
  const activeAnchor =
    state.view === "year" ? `${state.year}-01-01` : state.anchor;
  const canGoNext =
    state.view === "year"
      ? state.year < new Date().getFullYear()
      : periodStart(shiftAnchor(activeAnchor, state.period, 1), state.period) <=
        periodStart(localToday(), state.period);
  const move = (amount: number) =>
    update(
      state.view === "year"
        ? { year: state.year + amount }
        : { anchor: shiftAnchor(activeAnchor, state.period, amount) },
    );
  const filters = state.filters;
  const setFilter = (
    key: "modality" | "media" | "contributor" | "device",
    value: string,
  ) => update({ filters: { ...filters, [key]: value || undefined } });
  const priorTimeZone = useRef<string | null>(null);
  useEffect(() => {
    if (hydratedTimeZone === null) return;
    const prior = priorTimeZone.current;
    priorTimeZone.current = hydratedTimeZone;
    if (
      prior !== null &&
      prior !== hydratedTimeZone &&
      state.view === "stats" &&
      (state.period === "all" || state.anchor === localDateIn(prior))
    ) {
      const today = localDateIn(hydratedTimeZone);
      if (state.anchor !== today) update({ anchor: today });
    }
  }, [hydratedTimeZone, state, update]);
  const sessionCursor =
    nextSessionCursor ??
    (data?.activity.sessions.nextCursor.kind === "Present"
      ? data.activity.sessions.nextCursor.value
      : null);
  const loadMoreSessions = async () => {
    if (!hydratedTimeZone || !sessionCursor || loadingMoreSessions) return;
    setLoadingMoreSessions(true);
    try {
      const page = decodeActivitySessionPage(
        await apiFetch<unknown>(
          statsSessionsPath(state, hydratedTimeZone, sessionCursor) as ApiPath,
        ),
      );
      setExtraSessions((rows) => [...rows, ...page.sessions]);
      setNextSessionCursor(
        page.nextCursor.kind === "Present" ? page.nextCursor.value : "",
      );
    } finally {
      setLoadingMoreSessions(false);
    }
  };

  return (
    <main className={styles.pane} aria-busy={updating || initialLoading}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>
            {state.view === "year"
              ? "A factual annual record"
              : "Consumption activity"}
          </p>
          <h1>
            {state.view === "year"
              ? "Year in Reading"
              : "Reading, listening, and video-pane time"}
          </h1>
          <p className={styles.timeZone}>
            Local time · {hydratedTimeZone ?? "detecting your time zone"}
          </p>
        </div>
        <div className={styles.controls}>
          <div role="group" aria-label="Stats view">
            <button
              type="button"
              aria-pressed={state.view === "stats"}
              onClick={() => update({ view: "stats" })}
            >
              Stats
            </button>
            <button
              type="button"
              aria-pressed={state.view === "year"}
              onClick={() => update({ view: "year", period: "year" })}
            >
              Year
            </button>
          </div>
          {state.view === "stats" ? (
            <>
              <label>
                Period
                <select
                  value={state.period}
                  onChange={(event) =>
                    update({ period: event.target.value as StatsPeriod })
                  }
                >
                  {(Object.keys(PERIOD_LABEL) as StatsPeriod[]).map(
                    (period) => (
                      <option key={period} value={period}>
                        {PERIOD_LABEL[period]}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label>
                Anchor
                <input
                  type="date"
                  value={anchor}
                  onChange={(event) => update({ anchor: event.target.value })}
                />
              </label>
              {state.period !== "all" ? (
                <div role="group" aria-label="Date navigation">
                  <button type="button" onClick={() => move(-1)}>
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => update({ anchor: localToday() })}
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    onClick={() => move(1)}
                    disabled={!canGoNext}
                  >
                    Next
                  </button>
                </div>
              ) : null}
              <label>
                Modality
                <select
                  value={filters.modality ?? ""}
                  onChange={(event) =>
                    setFilter("modality", event.target.value)
                  }
                >
                  <option value="">All</option>
                  {MODALITIES.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              {(["media", "contributor", "device"] as const).map((key) =>
                filters[key] ? (
                  <span className={styles.filterChip} key={key}>
                    {selectedFilterLabel(data, key, filters[key])}
                    <button
                      type="button"
                      onClick={() => setFilter(key, "")}
                      aria-label={`Clear ${key} filter`}
                    >
                      ×
                    </button>
                  </span>
                ) : null,
              )}
            </>
          ) : (
            <>
              <label>
                Year
                <input
                  type="number"
                  min="1970"
                  max={new Date().getFullYear()}
                  value={state.year}
                  onChange={(event) =>
                    update({
                      year:
                        Number(event.target.value) || new Date().getFullYear(),
                    })
                  }
                />
              </label>
              <div role="group" aria-label="Year navigation">
                <button type="button" onClick={() => move(-1)}>
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => update({ year: new Date().getFullYear() })}
                >
                  This year
                </button>
                <button
                  type="button"
                  onClick={() => move(1)}
                  disabled={!canGoNext}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </div>
      </header>
      {updating ? (
        <p className={styles.busy} role="status">
          Updating{" "}
          {state.view === "year" ? state.year : PERIOD_LABEL[state.period]}.
          Showing the prior{" "}
          {committed?.state.view === "year"
            ? committed.state.year
            : PERIOD_LABEL[committed?.state.period ?? "day"]}{" "}
          result until it arrives.
        </p>
      ) : null}
      {initialLoading ? (
        <div className={styles.loading} aria-label="Loading statistics">
          <span />
          <span />
          <span />
        </div>
      ) : null}
      {resource.status === "error" && !data ? (
        <section className={styles.state} role="alert">
          <h2>Stats could not load</h2>
          <p>Try again. Nothing has been changed.</p>
          <button type="button" onClick={resource.retry}>
            Retry
          </button>
        </section>
      ) : null}
      {resource.status === "error" && data ? (
        <p className={styles.busy} role="status">
          Could not refresh this view. Showing the last loaded result.{" "}
          <button type="button" onClick={resource.retry}>
            Retry
          </button>
        </p>
      ) : null}
      {data && noActivity ? (
        <section className={styles.state}>
          <h2>
            {filterEmpty
              ? "No activity matches this view"
              : "No observed activity yet"}
          </h2>
          <p>
            {filterEmpty
              ? "Try a broader period."
              : "New reading, listening, and video-pane activity will appear here when it is recorded."}
          </p>
        </section>
      ) : null}
      {data &&
        (state.view === "year" ? (
          !wholeEmpty ? (
            <YearReading data={data} year={state.year} />
          ) : null
        ) : noActivity ? (
          !wholeEmpty ? (
            <>
              <Completions data={data} />
              <CreatedAndKept data={data} />
            </>
          ) : null
        ) : (
          <>
            <section className={styles.summary} aria-label="Activity summary">
              <div>
                <span>Active time</span>
                <strong>{duration(data.activity.totals.activeMs)}</strong>
              </div>
              <div>
                <span>Active days</span>
                <strong>{number(data.activity.totals.activeDays)}</strong>
              </div>
              <div>
                <span>
                  {isLivePeriod(state) ? "Current streak" : "Ending streak"}
                </span>
                <strong>
                  {number(data.activity.totals.streak)} days{" "}
                  <small>
                    best {number(data.activity.totals.longestStreak)}
                  </small>
                </strong>
              </div>
              <div>
                <span>Sessions</span>
                <strong>{number(data.activity.totals.sessionCount)}</strong>
              </div>
              <div>
                <span>Forward movement</span>
                <strong>{movement(data)}</strong>
              </div>
              <div>
                <span>Completions</span>
                <strong>{number(data.completion.total)}</strong>
              </div>
            </section>
            <Timeline data={data} />
            <div className={styles.grid}>
              <Heatmap data={data} />
              <Hours data={data} />
            </div>
            <WorkTables data={data} onFilter={setFilter} />
            <Section
              title="Sessions"
              detail="Server-derived sessions; time is clipped to this range."
              scope={data.activity}
            >
              <SessionRows
                rows={[...data.activity.sessions.rows, ...extraSessions]}
                nextCursor={sessionCursor}
                loadingMore={loadingMoreSessions}
                onLoadMore={() => void loadMoreSessions()}
              />
            </Section>
            <Completions data={data} />
            <CreatedAndKept data={data} />
          </>
        ))}
    </main>
  );
}
