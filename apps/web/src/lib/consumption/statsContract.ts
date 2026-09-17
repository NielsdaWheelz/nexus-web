import { decodePresence, type Presence } from "@/lib/api/presence";
import { expectExactRecord, expectRecord } from "@/lib/validation";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { tryParseContributorHandle } from "@/lib/contributors/handle";
import {
  parseActivityDeviceHandle,
  type ActivityDeviceHandle,
  parseActivityExclusionHandle,
  type ActivityExclusionHandle,
} from "./activityExclusions";

export type StatsPeriod = "day" | "week" | "month" | "year" | "all";
export type StatsView = "stats" | "year";
export type ActivityModality = "Reading" | "Listening" | "Viewing";

export interface StatsUrlState {
  view: StatsView;
  period: StatsPeriod;
  anchor: string;
  year: number;
  filters: {
    modality?: ActivityModality;
    media?: string;
    contributor?: string;
    device?: string;
  };
}

export interface Metrics {
  activeMs: number;
  forwardWordPosition: number;
  forwardMediaPositionMs: number;
}

export interface StatsTimelineRow extends Metrics {
  start: string;
  end: string;
  localLabel: string;
  utcOffsetMinutes: number;
  readingActiveMs: number;
  listeningActiveMs: number;
  viewingActiveMs: number;
}

export interface MediaStatsRow extends Metrics {
  mediaRef: string;
  title: string;
}
export interface ContributorStatsRow extends Metrics {
  contributorHandle: string;
  displayName: string;
  roles: string[];
}
export interface DeviceStatsRow {
  deviceHandle: ActivityDeviceHandle;
  label: string;
  firstObservedAt: string;
  lastObservedAt: string;
  deviceClasses: ("Desktop" | "Mobile")[];
  isCurrent: boolean;
  activeMs: number;
}

export interface DeviceSummary {
  deviceHandle: ActivityDeviceHandle;
  label: string;
}

export interface StatsSession extends Metrics {
  mediaRef: string;
  title: string;
  modality: ActivityModality;
  device: DeviceSummary;
  startedAt: string;
  endedAt: string;
  activeMs: number;
  firstProgress: Presence<number>;
  lastProgress: Presence<number>;
  continuesBeforeRange: boolean;
  continuesAfterRange: boolean;
}

export interface ActiveExclusion {
  exclusionHandle: ActivityExclusionHandle;
  mediaRef: string;
  title: string;
  modality: ActivityModality;
  device: DeviceSummary;
  startedAt: string;
  endedAt: string;
  excludedActiveMs: number;
}

interface ScopedSection {
  appliedFilters: string[];
  inapplicableFilters: string[];
}

export interface ConsumptionStats {
  activity: ScopedSection & {
    totals: Metrics & {
      recordedActiveMs: number;
      excludedActiveMs: number;
      activeDays: number;
      streak: number;
      longestStreak: number;
      sessionCount: number;
    };
    timeline: StatsTimelineRow[];
    localDays: { date: string; activeMs: number }[];
    localHours: { hour: number; activeMs: number }[];
    media: { rows: MediaStatsRow[]; otherActiveMs: number };
    contributors: {
      rows: ContributorStatsRow[];
      otherActiveMs: number;
      nonAdditive: true;
    };
    devices: DeviceStatsRow[];
    sessions: { rows: StatsSession[]; nextCursor: Presence<string> };
    longestSession: Presence<StatsSession>;
    activeExclusions: ActiveExclusion[];
  };
  completion: ScopedSection & {
    total: number;
    dates: { date: string; total: number }[];
    timeline: {
      start: string;
      end: string;
      localLabel: string;
      total: number;
    }[];
    media: { mediaRef: string; title: string; total: number }[];
    contributors: {
      contributorHandle: string;
      displayName: string;
      roles: string[];
      total: number;
    }[];
    byModality: Record<ActivityModality, number>;
  };
  retainedArtifacts: ScopedSection & {
    periodWide: true;
    highlights: number;
    noteBlocks: number;
    neutralLinks: number;
  };
}

const PERIODS = new Set<StatsPeriod>(["day", "week", "month", "year", "all"]);
const VIEWS = new Set<StatsView>(["stats", "year"]);
const MODALITIES = new Set<ActivityModality>([
  "Reading",
  "Listening",
  "Viewing",
]);

export function defaultStatsUrlState(now = new Date()): StatsUrlState {
  return {
    view: "stats",
    period: "day",
    anchor: localDate(now),
    year: now.getFullYear(),
    filters: {},
  };
}

export function decodeStatsUrlState(
  params: URLSearchParams,
  now = new Date(),
): StatsUrlState {
  const fallback = defaultStatsUrlState(now);
  const view = params.get("view");
  const period = params.get("period");
  const anchor = params.get("anchor");
  const rawYear = Number(params.get("year"));
  const currentYear = now.getFullYear();
  const rawModality = params.get("modality");
  const rawMedia = params.get("media");
  const parsedMedia = rawMedia ? parseResourceRef(rawMedia) : null;
  const rawContributor = params.get("contributor");
  const parsedContributor = rawContributor
    ? tryParseContributorHandle(rawContributor)
    : null;
  const rawDevice = params.get("device");
  const filters = {
    ...(rawModality && MODALITIES.has(rawModality as ActivityModality)
      ? { modality: rawModality as ActivityModality }
      : {}),
    ...(parsedMedia?.scheme === "media" && rawMedia ? { media: rawMedia } : {}),
    ...(parsedContributor ? { contributor: parsedContributor } : {}),
    ...(rawDevice && /^ncd1\.[A-Za-z0-9_-]{22}$/.test(rawDevice)
      ? { device: rawDevice }
      : {}),
  };
  const decoded = {
    view:
      view && VIEWS.has(view as StatsView)
        ? (view as StatsView)
        : fallback.view,
    period:
      period && PERIODS.has(period as StatsPeriod)
        ? (period as StatsPeriod)
        : fallback.period,
    anchor: anchor && isLocalDate(anchor) ? anchor : fallback.anchor,
    year:
      Number.isInteger(rawYear) && rawYear >= 1970 && rawYear <= currentYear
        ? rawYear
        : fallback.year,
    filters,
  };
  return decoded.view === "year"
    ? { ...decoded, period: "year", anchor: `${decoded.year}-01-01` }
    : decoded;
}

export function encodeStatsUrlState(
  state: StatsUrlState,
  _current: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams();
  next.set("view", state.view);
  if (state.view === "year") next.set("year", String(state.year));
  else {
    for (const [key, value] of Object.entries(state.filters))
      if (value) next.set(key, value);
    next.set("period", state.period);
    next.set("anchor", state.anchor);
  }
  return next;
}

export function statsRange(
  state: StatsUrlState,
  timeZone: string,
): { start?: string; end: string } {
  const [year, month, day] =
    state.view === "year"
      ? [state.year, 1, 1]
      : state.anchor.split("-").map(Number);
  const anchor =
    state.view === "year" ? { year, month: 1, day: 1 } : { year, month, day };
  if (state.view === "stats" && state.period === "week") {
    const weekday =
      new Date(
        Date.UTC(anchor.year, anchor.month - 1, anchor.day),
      ).getUTCDay() || 7;
    anchor.day -= weekday - 1;
  } else if (state.view === "stats" && state.period === "month") {
    anchor.day = 1;
  } else if (state.view === "stats" && state.period === "year") {
    anchor.month = 1;
    anchor.day = 1;
  }
  const start = zonedMidnight(anchor, timeZone);
  if (state.view === "stats" && state.period === "all") {
    const now = zonedCivil(new Date(), timeZone);
    const tomorrowDate = new Date(
      Date.UTC(now.year, now.month - 1, now.day + 1),
    );
    const tomorrow = {
      year: tomorrowDate.getUTCFullYear(),
      month: tomorrowDate.getUTCMonth() + 1,
      day: tomorrowDate.getUTCDate(),
    };
    return { end: zonedMidnight(tomorrow, timeZone).toISOString() };
  }
  const endCivil = new Date(
    Date.UTC(anchor.year, anchor.month - 1, anchor.day),
  );
  if (state.view === "year" || state.period === "year")
    endCivil.setUTCFullYear(endCivil.getUTCFullYear() + 1);
  else if (state.period === "month")
    endCivil.setUTCMonth(endCivil.getUTCMonth() + 1);
  else if (state.period === "week")
    endCivil.setUTCDate(endCivil.getUTCDate() + 7);
  else endCivil.setUTCDate(endCivil.getUTCDate() + 1);
  return {
    start: start.toISOString(),
    end: zonedMidnight(
      {
        year: endCivil.getUTCFullYear(),
        month: endCivil.getUTCMonth() + 1,
        day: endCivil.getUTCDate(),
      },
      timeZone,
    ).toISOString(),
  };
}

function zonedMidnight(
  civil: { year: number; month: number; day: number },
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(civil.year, civil.month - 1, civil.day);
  const offsetAt = (instant: number) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(instant));
    const part = (type: string) =>
      Number(parts.find((item) => item.type === type)?.value);
    return (
      Date.UTC(
        part("year"),
        part("month") - 1,
        part("day"),
        part("hour"),
        part("minute"),
        part("second"),
      ) - instant
    );
  };
  let instant = utcGuess - offsetAt(utcGuess);
  instant = utcGuess - offsetAt(instant);
  return new Date(instant);
}

function zonedCivil(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function statsPath(
  state: StatsUrlState,
  timeZone: string,
): `/api/${string}` {
  const query = new URLSearchParams({
    timeZone,
    bucket:
      state.view === "year" || state.period === "year"
        ? "Month"
        : state.period === "day"
          ? "Hour"
          : state.period === "all"
            ? "Year"
            : "Day",
  });
  const range = statsRange(state, timeZone);
  if (range.start) query.set("start", range.start);
  query.set("end", range.end);
  for (const [key, value] of Object.entries(state.filters))
    if (value) {
      const apiKey =
        key === "media"
          ? "mediaRef"
          : key === "contributor"
            ? "contributorHandle"
            : key === "device"
              ? "deviceHandle"
              : key;
      query.set(apiKey, value);
    }
  return `/api/consumption/stats?${query}`;
}

export function statsSessionsPath(
  state: StatsUrlState,
  timeZone: string,
  cursor?: string,
): `/api/${string}` {
  const query = new URLSearchParams({ timeZone, limit: "50" });
  const range = statsRange(state, timeZone);
  if (range.start) query.set("start", range.start);
  query.set("end", range.end);
  if (cursor) query.set("cursor", cursor);
  for (const [key, value] of Object.entries(state.filters))
    if (value) {
      const apiKey =
        key === "media"
          ? "mediaRef"
          : key === "contributor"
            ? "contributorHandle"
            : key === "device"
              ? "deviceHandle"
              : key;
      query.set(apiKey, value);
    }
  return `/api/consumption/sessions?${query}`;
}

function numberAt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid Stats response: ${name}`);
  }
  return value;
}

function signedOffsetMinutes(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < -840 ||
    value > 840
  ) {
    throw new Error(`Invalid Stats response: ${name}`);
  }
  return value;
}

function stringAt(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`Invalid Stats response: ${name}`);
  return value;
}

function mediaRefAt(value: unknown, name: string): string {
  const raw = stringAt(value, name);
  const parsed = parseResourceRef(raw);
  if (!parsed || parsed.scheme !== "media")
    throw new Error(`Invalid Stats response: ${name}`);
  return raw;
}

function deviceHandleAt(value: unknown, name: string): ActivityDeviceHandle {
  const raw = stringAt(value, name);
  try {
    return parseActivityDeviceHandle(raw);
  } catch {
    throw new Error(`Invalid Stats response: ${name}`);
  }
}

function activityExclusionHandleAt(
  value: unknown,
  name: string,
): ActivityExclusionHandle {
  const raw = stringAt(value, name);
  try {
    return parseActivityExclusionHandle(raw);
  } catch {
    throw new Error(`Invalid Stats response: ${name}`);
  }
}

function deviceSummaryAt(value: unknown, name: string): DeviceSummary {
  const record = expectExactRecord(value, ["deviceHandle", "label"], name);
  return {
    deviceHandle: deviceHandleAt(record.deviceHandle, `${name}.deviceHandle`),
    label: stringAt(record.label, `${name}.label`),
  };
}

function contributorHandleAt(value: unknown, name: string): string {
  const raw = stringAt(value, name);
  if (!tryParseContributorHandle(raw)) {
    throw new Error(`Invalid Stats response: ${name}`);
  }
  return raw;
}

function instantAt(value: unknown, name: string): string {
  const raw = stringAt(value, name);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      raw,
    ) ||
    Number.isNaN(Date.parse(raw))
  ) {
    throw new Error(`Invalid Stats response: ${name}`);
  }
  return raw;
}

function localDateAt(value: unknown, name: string): string {
  const raw = stringAt(value, name);
  if (!isLocalDate(raw)) throw new Error(`Invalid Stats response: ${name}`);
  return raw;
}

function isLocalDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function metrics(value: Record<string, unknown>, name: string): Metrics {
  return {
    activeMs: numberAt(value.activeMs, `${name}.activeMs`),
    forwardWordPosition: numberAt(
      value.forwardWordPosition,
      `${name}.forwardWordPosition`,
    ),
    forwardMediaPositionMs: numberAt(
      value.forwardMediaPositionMs,
      `${name}.forwardMediaPositionMs`,
    ),
  };
}

function statsSessionAt(input: unknown, name: string): StatsSession {
  const record = expectExactRecord(
    input,
    [
      "mediaRef",
      "title",
      "modality",
      "device",
      "startedAt",
      "endedAt",
      "activeMs",
      "forwardWordPosition",
      "forwardMediaPositionMs",
      "firstProgress",
      "lastProgress",
      "continuesBeforeRange",
      "continuesAfterRange",
    ],
    name,
  );
  const modality = stringAt(record.modality, `${name}.modality`);
  if (!MODALITIES.has(modality as ActivityModality)) {
    throw new Error(`Invalid Stats response: ${name}.modality`);
  }
  if (
    typeof record.continuesBeforeRange !== "boolean" ||
    typeof record.continuesAfterRange !== "boolean"
  ) {
    throw new Error(`Invalid Stats response: ${name}.continues`);
  }
  return {
    ...metrics(record, name),
    mediaRef: mediaRefAt(record.mediaRef, `${name}.mediaRef`),
    title: stringAt(record.title, `${name}.title`),
    modality: modality as ActivityModality,
    device: deviceSummaryAt(record.device, `${name}.device`),
    startedAt: instantAt(record.startedAt, `${name}.startedAt`),
    endedAt: instantAt(record.endedAt, `${name}.endedAt`),
    activeMs: numberAt(record.activeMs, `${name}.activeMs`),
    firstProgress: decodePresence(record.firstProgress, (raw) =>
      numberAt(raw, `${name}.firstProgress.value`),
    ),
    lastProgress: decodePresence(record.lastProgress, (raw) =>
      numberAt(raw, `${name}.lastProgress.value`),
    ),
    continuesBeforeRange: record.continuesBeforeRange,
    continuesAfterRange: record.continuesAfterRange,
  };
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid Stats response: ${name}`);
  return value;
}

function dataEnvelope(value: unknown, name: string): unknown {
  return expectExactRecord(value, ["data"], name).data;
}

export function decodeConsumptionStats(value: unknown): ConsumptionStats {
  const root = expectExactRecord(
    dataEnvelope(value, "Stats response"),
    ["activity", "completion", "retainedArtifacts"],
    "Stats",
  );
  const activity = expectExactRecord(
    root.activity,
    [
      "appliedFilters",
      "inapplicableFilters",
      "totals",
      "timeline",
      "localDays",
      "localHours",
      "media",
      "contributors",
      "devices",
      "sessions",
      "longestSession",
      "activeExclusions",
    ],
    "activity",
  );
  const scoped = (
    section: Record<string, unknown>,
    name: string,
  ): ScopedSection => ({
    appliedFilters: array(section.appliedFilters, `${name}.appliedFilters`).map(
      (item) => stringAt(item, `${name}.appliedFilters[]`),
    ),
    inapplicableFilters: array(
      section.inapplicableFilters,
      `${name}.inapplicableFilters`,
    ).map((item) => stringAt(item, `${name}.inapplicableFilters[]`)),
  });
  const totals = expectExactRecord(
    activity.totals,
    [
      "activeMs",
      "recordedActiveMs",
      "excludedActiveMs",
      "forwardWordPosition",
      "forwardMediaPositionMs",
      "activeDays",
      "streak",
      "longestStreak",
      "sessionCount",
    ],
    "activity.totals",
  );
  const media = expectExactRecord(
    activity.media,
    ["rows", "otherActiveMs"],
    "activity.media",
  );
  const mediaRows = array(media.rows, "activity.media.rows").map(
    (row, index): MediaStatsRow => {
      const name = `activity.media.rows[${index}]`;
      const record = expectExactRecord(
        row,
        [
          "mediaRef",
          "title",
          "activeMs",
          "forwardWordPosition",
          "forwardMediaPositionMs",
        ],
        name,
      );
      return {
        ...metrics(record, name),
        mediaRef: mediaRefAt(record.mediaRef, "activity.media.rows.mediaRef"),
        title: stringAt(record.title, "activity.media.rows.title"),
      };
    },
  );
  const contributors = expectExactRecord(
    activity.contributors,
    ["rows", "otherActiveMs", "nonAdditive"],
    "activity.contributors",
  );
  if (contributors.nonAdditive !== true) {
    throw new Error("Invalid Stats response: activity.contributors");
  }
  const contributorRows = array(
    contributors.rows,
    "activity.contributors.rows",
  ).map((row, index): ContributorStatsRow => {
    const name = `activity.contributors.rows[${index}]`;
    const record = expectExactRecord(
      row,
      [
        "contributorHandle",
        "displayName",
        "roles",
        "activeMs",
        "forwardWordPosition",
        "forwardMediaPositionMs",
      ],
      name,
    );
    return {
      ...metrics(record, name),
      contributorHandle: contributorHandleAt(
        record.contributorHandle,
        "activity.contributors.contributorHandle",
      ),
      displayName: stringAt(
        record.displayName,
        "activity.contributors.displayName",
      ),
      roles: array(record.roles, "activity.contributors.roles").map((role) =>
        stringAt(role, "activity.contributors.roles[]"),
      ),
    };
  });
  const devices = array(activity.devices, "activity.devices").map(
    (row, index): DeviceStatsRow => {
      const record = expectExactRecord(
        row,
        [
          "deviceHandle",
          "label",
          "firstObservedAt",
          "lastObservedAt",
          "deviceClasses",
          "isCurrent",
          "activeMs",
        ],
        `activity.devices[${index}]`,
      );
      const deviceClasses = array(
        record.deviceClasses,
        "activity.devices.deviceClasses",
      ).map((item) => stringAt(item, "activity.devices.deviceClasses[]"));
      if (deviceClasses.some((item) => item !== "Desktop" && item !== "Mobile"))
        throw new Error(
          "Invalid Stats response: activity.devices.deviceClasses",
        );
      if (typeof record.isCurrent !== "boolean")
        throw new Error("Invalid Stats response: activity.devices.isCurrent");
      return {
        deviceHandle: deviceHandleAt(
          record.deviceHandle,
          "activity.devices.deviceHandle",
        ),
        label: stringAt(record.label, "activity.devices.label"),
        firstObservedAt: instantAt(
          record.firstObservedAt,
          "activity.devices.firstObservedAt",
        ),
        lastObservedAt: instantAt(
          record.lastObservedAt,
          "activity.devices.lastObservedAt",
        ),
        deviceClasses: deviceClasses as ("Desktop" | "Mobile")[],
        isCurrent: record.isCurrent,
        activeMs: numberAt(record.activeMs, "activity.devices.activeMs"),
      };
    },
  );
  const timeline = array(activity.timeline, "activity.timeline").map(
    (row, index) => {
      const name = `timeline[${index}]`;
      const record = expectExactRecord(
        row,
        [
          "start",
          "end",
          "localLabel",
          "utcOffsetMinutes",
          "readingActiveMs",
          "listeningActiveMs",
          "viewingActiveMs",
          "activeMs",
          "forwardWordPosition",
          "forwardMediaPositionMs",
        ],
        name,
      );
      return {
        ...metrics(record, name),
        start: instantAt(record.start, "timeline.start"),
        end: instantAt(record.end, "timeline.end"),
        localLabel: stringAt(record.localLabel, "timeline.localLabel"),
        utcOffsetMinutes: signedOffsetMinutes(
          record.utcOffsetMinutes,
          "timeline.utcOffsetMinutes",
        ),
        readingActiveMs: numberAt(
          record.readingActiveMs,
          "timeline.readingActiveMs",
        ),
        listeningActiveMs: numberAt(
          record.listeningActiveMs,
          "timeline.listeningActiveMs",
        ),
        viewingActiveMs: numberAt(
          record.viewingActiveMs,
          "timeline.viewingActiveMs",
        ),
      };
    },
  );
  const sessions = expectExactRecord(
    activity.sessions,
    ["rows", "nextCursor"],
    "activity.sessions",
  );
  const completion = expectExactRecord(
    root.completion,
    [
      "appliedFilters",
      "inapplicableFilters",
      "total",
      "dates",
      "timeline",
      "media",
      "contributors",
      "byModality",
    ],
    "completion",
  );
  const byModality = expectRecord(
    completion.byModality,
    "completion.byModality",
  );
  const retained = expectExactRecord(
    root.retainedArtifacts,
    [
      "appliedFilters",
      "inapplicableFilters",
      "periodWide",
      "highlights",
      "noteBlocks",
      "neutralLinks",
    ],
    "retainedArtifacts",
  );
  if (retained.periodWide !== true) {
    throw new Error("Invalid Stats response: retainedArtifacts.periodWide");
  }
  return {
    activity: {
      ...scoped(activity, "activity"),
      totals: {
        ...metrics(totals, "activity.totals"),
        recordedActiveMs: numberAt(
          totals.recordedActiveMs,
          "totals.recordedActiveMs",
        ),
        excludedActiveMs: numberAt(
          totals.excludedActiveMs,
          "totals.excludedActiveMs",
        ),
        activeDays: numberAt(totals.activeDays, "totals.activeDays"),
        streak: numberAt(totals.streak, "totals.streak"),
        longestStreak: numberAt(totals.longestStreak, "totals.longestStreak"),
        sessionCount: numberAt(totals.sessionCount, "totals.sessionCount"),
      },
      timeline,
      localDays: array(activity.localDays, "activity.localDays").map((row) => {
        const record = expectExactRecord(
          row,
          ["date", "activeMs"],
          "activity.localDays[]",
        );
        return {
          date: localDateAt(record.date, "localDays.date"),
          activeMs: numberAt(record.activeMs, "localDays.activeMs"),
        };
      }),
      localHours: array(activity.localHours, "activity.localHours").map(
        (row) => {
          const record = expectExactRecord(
            row,
            ["hour", "activeMs"],
            "activity.localHours[]",
          );
          const hour = numberAt(record.hour, "localHours.hour");
          if (!Number.isInteger(hour) || hour > 23) {
            throw new Error("Invalid Stats response: localHours.hour");
          }
          return {
            hour,
            activeMs: numberAt(record.activeMs, "localHours.activeMs"),
          };
        },
      ),
      media: {
        rows: mediaRows,
        otherActiveMs: numberAt(
          media.otherActiveMs,
          "activity.media.otherActiveMs",
        ),
      },
      contributors: {
        rows: contributorRows,
        otherActiveMs: numberAt(
          contributors.otherActiveMs,
          "activity.contributors.otherActiveMs",
        ),
        nonAdditive: true as const,
      },
      devices,
      sessions: {
        rows: array(sessions.rows, "activity.sessions.rows").map(
          (item, index) =>
            statsSessionAt(item, `activity.sessions.rows[${index}]`),
        ),
        nextCursor: decodePresence(sessions.nextCursor, (raw) =>
          stringAt(raw, "activity.sessions.nextCursor.value"),
        ),
      },
      longestSession: decodePresence(activity.longestSession, (raw) =>
        statsSessionAt(raw, "activity.longestSession.value"),
      ),
      activeExclusions: array(
        activity.activeExclusions,
        "activity.activeExclusions",
      ).map((item, index): ActiveExclusion => {
        const name = `activity.activeExclusions[${index}]`;
        const record = expectExactRecord(
          item,
          [
            "exclusionHandle",
            "mediaRef",
            "title",
            "modality",
            "device",
            "startedAt",
            "endedAt",
            "excludedActiveMs",
          ],
          name,
        );
        const modality = stringAt(record.modality, `${name}.modality`);
        if (!MODALITIES.has(modality as ActivityModality)) {
          throw new Error(`Invalid Stats response: ${name}.modality`);
        }
        return {
          exclusionHandle: activityExclusionHandleAt(
            record.exclusionHandle,
            `${name}.exclusionHandle`,
          ),
          mediaRef: mediaRefAt(record.mediaRef, `${name}.mediaRef`),
          title: stringAt(record.title, `${name}.title`),
          modality: modality as ActivityModality,
          device: deviceSummaryAt(record.device, `${name}.device`),
          startedAt: instantAt(record.startedAt, `${name}.startedAt`),
          endedAt: instantAt(record.endedAt, `${name}.endedAt`),
          excludedActiveMs: numberAt(
            record.excludedActiveMs,
            `${name}.excludedActiveMs`,
          ),
        };
      }),
    },
    completion: {
      ...scoped(completion, "completion"),
      total: numberAt(completion.total, "completion.total"),
      dates: array(completion.dates, "completion.dates").map((item) => {
        const record = expectExactRecord(
          item,
          ["date", "total"],
          "completion.dates[]",
        );
        return {
          date: localDateAt(record.date, "completion.dates.date"),
          total: numberAt(record.total, "completion.dates.total"),
        };
      }),
      timeline: array(completion.timeline, "completion.timeline").map(
        (item) => {
          const record = expectExactRecord(
            item,
            ["start", "end", "localLabel", "total"],
            "completion.timeline[]",
          );
          return {
            start: instantAt(record.start, "completion.timeline.start"),
            end: instantAt(record.end, "completion.timeline.end"),
            localLabel: stringAt(
              record.localLabel,
              "completion.timeline.localLabel",
            ),
            total: numberAt(record.total, "completion.timeline.total"),
          };
        },
      ),
      media: array(completion.media, "completion.media").map((item) => {
        const record = expectExactRecord(
          item,
          ["mediaRef", "title", "total"],
          "completion.media[]",
        );
        return {
          mediaRef: mediaRefAt(record.mediaRef, "completion.media.mediaRef"),
          title: stringAt(record.title, "completion.media.title"),
          total: numberAt(record.total, "completion.media.total"),
        };
      }),
      contributors: array(
        completion.contributors,
        "completion.contributors",
      ).map((item) => {
        const record = expectExactRecord(
          item,
          ["contributorHandle", "displayName", "roles", "total"],
          "completion.contributors[]",
        );
        return {
          contributorHandle: contributorHandleAt(
            record.contributorHandle,
            "completion.contributors.contributorHandle",
          ),
          displayName: stringAt(
            record.displayName,
            "completion.contributors.displayName",
          ),
          roles: array(record.roles, "completion.contributors.roles").map(
            (role) => stringAt(role, "completion.contributors.roles[]"),
          ),
          total: numberAt(record.total, "completion.contributors.total"),
        };
      }),
      byModality: {
        Reading: numberAt(byModality.Reading, "completion.byModality.Reading"),
        Listening: numberAt(
          byModality.Listening,
          "completion.byModality.Listening",
        ),
        Viewing: numberAt(byModality.Viewing, "completion.byModality.Viewing"),
      },
    },
    retainedArtifacts: {
      ...scoped(retained, "retainedArtifacts"),
      periodWide: true,
      highlights: numberAt(retained.highlights, "retainedArtifacts.highlights"),
      noteBlocks: numberAt(retained.noteBlocks, "retainedArtifacts.noteBlocks"),
      neutralLinks: numberAt(
        retained.neutralLinks,
        "retainedArtifacts.neutralLinks",
      ),
    },
  };
}

/** The independent, cursor-paginated session read. It intentionally has no stats fallback. */
export function decodeActivitySessionPage(value: unknown): {
  sessions: StatsSession[];
  nextCursor: Presence<string>;
} {
  const page = expectExactRecord(
    dataEnvelope(value, "session page response"),
    ["sessions", "nextCursor"],
    "session page",
  );
  return {
    sessions: array(page.sessions, "sessions").map((item, index) =>
      statsSessionAt(item, `sessions[${index}]`),
    ),
    nextCursor: decodePresence(page.nextCursor, (raw) =>
      stringAt(raw, "nextCursor.value"),
    ),
  };
}

function localDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
