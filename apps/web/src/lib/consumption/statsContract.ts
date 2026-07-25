import { expectExactRecord, isRecord } from "@/lib/validation";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { tryParseContributorHandle } from "@/lib/contributors/handle";

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

export type Presence<T> = { kind: "Absent" } | { kind: "Present"; value: T };

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
  deviceHandle: string;
  label: string;
  firstObservedAt: string;
  lastObservedAt: string;
  deviceClasses: ("Desktop" | "Mobile")[];
  isCurrent: boolean;
  activeMs: number;
}

export interface StatsSession extends Metrics {
  mediaRef: string;
  title: string;
  modality: ActivityModality;
  device: { deviceHandle: string; label: string };
  startedAt: string;
  endedAt: string;
  activeMs: number;
  firstProgress: Presence<number>;
  lastProgress: Presence<number>;
  continuesBeforeRange: boolean;
  continuesAfterRange: boolean;
}

interface ScopedSection {
  appliedFilters: string[];
  inapplicableFilters: string[];
}

export interface ConsumptionStats {
  activity: ScopedSection & {
    totals: Metrics & {
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

function deviceHandleAt(value: unknown, name: string): string {
  const raw = stringAt(value, name);
  if (!/^ncd1\.[A-Za-z0-9_-]{22}$/.test(raw))
    throw new Error(`Invalid Stats response: ${name}`);
  return raw;
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

function metrics(value: unknown, name: string): Metrics {
  if (!isRecord(value)) throw new Error(`Invalid Stats response: ${name}`);
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

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid Stats response: ${name}`);
  return value;
}

function dataEnvelope(value: unknown, name: string): unknown {
  if (!isRecord(value)) throw new Error(`Invalid Stats response: ${name}`);
  expectExactRecord(value, ["data"], name);
  return value.data;
}

export function decodeConsumptionStats(value: unknown): ConsumptionStats {
  const root = dataEnvelope(value, "Stats response");
  if (
    !isRecord(root) ||
    !isRecord(root.activity) ||
    !isRecord(root.completion) ||
    !isRecord(root.retainedArtifacts)
  ) {
    throw new Error("Invalid Stats response");
  }
  const activity = root.activity;
  expectExactRecord(
    root,
    ["activity", "completion", "retainedArtifacts"],
    "Stats",
  );
  expectExactRecord(
    activity,
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
  const presence = <T>(
    input: unknown,
    name: string,
    decode: (raw: unknown) => T,
  ): Presence<T> => {
    if (
      !isRecord(input) ||
      (input.kind !== "Absent" && input.kind !== "Present")
    )
      throw new Error(`Invalid Stats response: ${name}`);
    if (input.kind === "Absent") {
      if (Object.keys(input).length !== 1)
        throw new Error(`Invalid Stats response: ${name}`);
      return { kind: "Absent" };
    }
    if (Object.keys(input).length !== 2)
      throw new Error(`Invalid Stats response: ${name}`);
    return { kind: "Present", value: decode(input.value) };
  };
  const session = (input: unknown, name: string): StatsSession => {
    expectExactRecord(
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
    if (!isRecord(input) || !isRecord(input.device))
      throw new Error(`Invalid Stats response: ${name}`);
    expectExactRecord(
      input.device,
      ["deviceHandle", "label"],
      `${name}.device`,
    );
    const modality = stringAt(input.modality, `${name}.modality`);
    if (!MODALITIES.has(modality as ActivityModality))
      throw new Error(`Invalid Stats response: ${name}.modality`);
    if (
      typeof input.continuesBeforeRange !== "boolean" ||
      typeof input.continuesAfterRange !== "boolean"
    )
      throw new Error(`Invalid Stats response: ${name}.continues`);
    return {
      ...metrics(input, name),
      mediaRef: mediaRefAt(input.mediaRef, `${name}.mediaRef`),
      title: stringAt(input.title, `${name}.title`),
      modality: modality as ActivityModality,
      device: {
        deviceHandle: deviceHandleAt(
          input.device.deviceHandle,
          `${name}.device.deviceHandle`,
        ),
        label: stringAt(input.device.label, `${name}.device.label`),
      },
      startedAt: instantAt(input.startedAt, `${name}.startedAt`),
      endedAt: instantAt(input.endedAt, `${name}.endedAt`),
      activeMs: numberAt(input.activeMs, `${name}.activeMs`),
      firstProgress: presence(
        input.firstProgress,
        `${name}.firstProgress`,
        (raw) => numberAt(raw, `${name}.firstProgress.value`),
      ),
      lastProgress: presence(
        input.lastProgress,
        `${name}.lastProgress`,
        (raw) => numberAt(raw, `${name}.lastProgress.value`),
      ),
      continuesBeforeRange: input.continuesBeforeRange,
      continuesAfterRange: input.continuesAfterRange,
    };
  };
  const totals = metrics(activity.totals, "activity.totals");
  if (!isRecord(activity.totals))
    throw new Error("Invalid Stats response: activity.totals");
  expectExactRecord(
    activity.totals,
    [
      "activeMs",
      "forwardWordPosition",
      "forwardMediaPositionMs",
      "activeDays",
      "streak",
      "longestStreak",
      "sessionCount",
    ],
    "activity.totals",
  );
  const mediaRows = array(
    activity.media && isRecord(activity.media)
      ? activity.media.rows
      : undefined,
    "activity.media.rows",
  ).map((row, index): MediaStatsRow => {
    if (!isRecord(row))
      throw new Error(`Invalid Stats response: activity.media.rows[${index}]`);
    expectExactRecord(
      row,
      [
        "mediaRef",
        "title",
        "activeMs",
        "forwardWordPosition",
        "forwardMediaPositionMs",
      ],
      `activity.media.rows[${index}]`,
    );
    return {
      ...metrics(row, `activity.media.rows[${index}]`),
      mediaRef: mediaRefAt(row.mediaRef, "activity.media.rows.mediaRef"),
      title: stringAt(row.title, "activity.media.rows.title"),
    };
  });
  const contributorRows = array(
    activity.contributors && isRecord(activity.contributors)
      ? activity.contributors.rows
      : undefined,
    "activity.contributors.rows",
  ).map((row, index): ContributorStatsRow => {
    if (!isRecord(row))
      throw new Error(
        `Invalid Stats response: activity.contributors.rows[${index}]`,
      );
    expectExactRecord(
      row,
      [
        "contributorHandle",
        "displayName",
        "roles",
        "activeMs",
        "forwardWordPosition",
        "forwardMediaPositionMs",
      ],
      `activity.contributors.rows[${index}]`,
    );
    return {
      ...metrics(row, `activity.contributors.rows[${index}]`),
      contributorHandle: contributorHandleAt(
        row.contributorHandle,
        "activity.contributors.contributorHandle",
      ),
      displayName: stringAt(
        row.displayName,
        "activity.contributors.displayName",
      ),
      roles: array(row.roles, "activity.contributors.roles").map((role) =>
        stringAt(role, "activity.contributors.roles[]"),
      ),
    };
  });
  const devices = array(activity.devices, "activity.devices").map(
    (row, index): DeviceStatsRow => {
      if (!isRecord(row))
        throw new Error(`Invalid Stats response: activity.devices[${index}]`);
      expectExactRecord(
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
        row.deviceClasses,
        "activity.devices.deviceClasses",
      ).map((item) => stringAt(item, "activity.devices.deviceClasses[]"));
      if (deviceClasses.some((item) => item !== "Desktop" && item !== "Mobile"))
        throw new Error(
          "Invalid Stats response: activity.devices.deviceClasses",
        );
      if (typeof row.isCurrent !== "boolean")
        throw new Error("Invalid Stats response: activity.devices.isCurrent");
      return {
        deviceHandle: deviceHandleAt(
          row.deviceHandle,
          "activity.devices.deviceHandle",
        ),
        label: stringAt(row.label, "activity.devices.label"),
        firstObservedAt: instantAt(
          row.firstObservedAt,
          "activity.devices.firstObservedAt",
        ),
        lastObservedAt: instantAt(
          row.lastObservedAt,
          "activity.devices.lastObservedAt",
        ),
        deviceClasses: deviceClasses as ("Desktop" | "Mobile")[],
        isCurrent: row.isCurrent,
        activeMs: numberAt(row.activeMs, "activity.devices.activeMs"),
      };
    },
  );
  const timeline = array(activity.timeline, "activity.timeline").map(
    (row, index) => {
      if (!isRecord(row))
        throw new Error(`Invalid Stats response: timeline[${index}]`);
      expectExactRecord(
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
        `timeline[${index}]`,
      );
      return {
        ...metrics(row, `timeline[${index}]`),
        start: instantAt(row.start, "timeline.start"),
        end: instantAt(row.end, "timeline.end"),
        localLabel: stringAt(row.localLabel, "timeline.localLabel"),
        utcOffsetMinutes: signedOffsetMinutes(
          row.utcOffsetMinutes,
          "timeline.utcOffsetMinutes",
        ),
        readingActiveMs: numberAt(
          row.readingActiveMs,
          "timeline.readingActiveMs",
        ),
        listeningActiveMs: numberAt(
          row.listeningActiveMs,
          "timeline.listeningActiveMs",
        ),
        viewingActiveMs: numberAt(
          row.viewingActiveMs,
          "timeline.viewingActiveMs",
        ),
      };
    },
  );
  const retained = root.retainedArtifacts;
  const byModality = root.completion.byModality;
  if (!isRecord(byModality))
    throw new Error("Invalid Stats response: completion.byModality");
  const completion = root.completion;
  expectExactRecord(
    activity.media,
    ["rows", "otherActiveMs"],
    "activity.media",
  );
  expectExactRecord(
    activity.contributors,
    ["rows", "otherActiveMs", "nonAdditive"],
    "activity.contributors",
  );
  expectExactRecord(
    activity.sessions,
    ["rows", "nextCursor"],
    "activity.sessions",
  );
  expectExactRecord(
    completion,
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
  expectExactRecord(
    retained,
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
  return {
    activity: {
      ...scoped(activity, "activity"),
      totals: {
        ...totals,
        activeDays: numberAt(activity.totals.activeDays, "totals.activeDays"),
        streak: numberAt(activity.totals.streak, "totals.streak"),
        longestStreak: numberAt(
          activity.totals.longestStreak,
          "totals.longestStreak",
        ),
        sessionCount: numberAt(
          activity.totals.sessionCount,
          "totals.sessionCount",
        ),
      },
      timeline,
      localDays: array(activity.localDays, "activity.localDays").map((row) => {
        if (!isRecord(row))
          throw new Error("Invalid Stats response: localDays");
        expectExactRecord(row, ["date", "activeMs"], "activity.localDays[]");
        return {
          date: localDateAt(row.date, "localDays.date"),
          activeMs: numberAt(row.activeMs, "localDays.activeMs"),
        };
      }),
      localHours: array(activity.localHours, "activity.localHours").map(
        (row) => {
          if (!isRecord(row))
            throw new Error("Invalid Stats response: localHours");
          expectExactRecord(row, ["hour", "activeMs"], "activity.localHours[]");
          if (
            !Number.isInteger(row.hour) ||
            (row.hour as number) < 0 ||
            (row.hour as number) > 23
          )
            throw new Error("Invalid Stats response: localHours.hour");
          return {
            hour: numberAt(row.hour, "localHours.hour"),
            activeMs: numberAt(row.activeMs, "localHours.activeMs"),
          };
        },
      ),
      media: (() => {
        if (!isRecord(activity.media))
          throw new Error("Invalid Stats response: activity.media");
        return {
          rows: mediaRows,
          otherActiveMs: numberAt(
            activity.media.otherActiveMs,
            "activity.media.otherActiveMs",
          ),
        };
      })(),
      contributors: (() => {
        if (
          !isRecord(activity.contributors) ||
          activity.contributors.nonAdditive !== true
        )
          throw new Error("Invalid Stats response: activity.contributors");
        return {
          rows: contributorRows,
          otherActiveMs: numberAt(
            activity.contributors.otherActiveMs,
            "activity.contributors.otherActiveMs",
          ),
          nonAdditive: true as const,
        };
      })(),
      devices,
      sessions: (() => {
        if (!isRecord(activity.sessions))
          throw new Error("Invalid Stats response: activity.sessions");
        return {
          rows: array(activity.sessions.rows, "activity.sessions.rows").map(
            (item, index) => session(item, `activity.sessions.rows[${index}]`),
          ),
          nextCursor: presence(
            activity.sessions.nextCursor,
            "activity.sessions.nextCursor",
            (raw) => stringAt(raw, "activity.sessions.nextCursor.value"),
          ),
        };
      })(),
      longestSession: presence(
        activity.longestSession,
        "activity.longestSession",
        (raw) => session(raw, "activity.longestSession.value"),
      ),
    },
    completion: {
      ...scoped(completion, "completion"),
      total: numberAt(completion.total, "completion.total"),
      dates: array(completion.dates, "completion.dates").map((item) => {
        if (!isRecord(item))
          throw new Error("Invalid Stats response: completion.dates");
        expectExactRecord(item, ["date", "total"], "completion.dates[]");
        return {
          date: localDateAt(item.date, "completion.dates.date"),
          total: numberAt(item.total, "completion.dates.total"),
        };
      }),
      timeline: array(completion.timeline, "completion.timeline").map(
        (item) => {
          if (!isRecord(item))
            throw new Error("Invalid Stats response: completion.timeline");
          expectExactRecord(
            item,
            ["start", "end", "localLabel", "total"],
            "completion.timeline[]",
          );
          return {
            start: instantAt(item.start, "completion.timeline.start"),
            end: instantAt(item.end, "completion.timeline.end"),
            localLabel: stringAt(
              item.localLabel,
              "completion.timeline.localLabel",
            ),
            total: numberAt(item.total, "completion.timeline.total"),
          };
        },
      ),
      media: array(completion.media, "completion.media").map((item) => {
        if (!isRecord(item))
          throw new Error("Invalid Stats response: completion.media");
        expectExactRecord(
          item,
          ["mediaRef", "title", "total"],
          "completion.media[]",
        );
        return {
          mediaRef: mediaRefAt(item.mediaRef, "completion.media.mediaRef"),
          title: stringAt(item.title, "completion.media.title"),
          total: numberAt(item.total, "completion.media.total"),
        };
      }),
      contributors: array(
        completion.contributors,
        "completion.contributors",
      ).map((item) => {
        if (!isRecord(item))
          throw new Error("Invalid Stats response: completion.contributors");
        expectExactRecord(
          item,
          ["contributorHandle", "displayName", "roles", "total"],
          "completion.contributors[]",
        );
        return {
          contributorHandle: contributorHandleAt(
            item.contributorHandle,
            "completion.contributors.contributorHandle",
          ),
          displayName: stringAt(
            item.displayName,
            "completion.contributors.displayName",
          ),
          roles: array(item.roles, "completion.contributors.roles").map(
            (role) => stringAt(role, "completion.contributors.roles[]"),
          ),
          total: numberAt(item.total, "completion.contributors.total"),
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
      periodWide:
        retained.periodWide === true
          ? true
          : (() => {
              throw new Error(
                "Invalid Stats response: retainedArtifacts.periodWide",
              );
            })(),
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
  const page = dataEnvelope(value, "session page response");
  if (!isRecord(page)) throw new Error("Invalid session page");
  expectExactRecord(page, ["sessions", "nextCursor"], "session page");
  const decodePresenceString = (input: unknown): Presence<string> => {
    if (
      !isRecord(input) ||
      (input.kind !== "Absent" && input.kind !== "Present")
    )
      throw new Error("Invalid session page: nextCursor");
    if (input.kind === "Absent" && Object.keys(input).length === 1)
      return { kind: "Absent" };
    if (input.kind === "Present" && Object.keys(input).length === 2)
      return {
        kind: "Present",
        value: stringAt(input.value, "nextCursor.value"),
      };
    throw new Error("Invalid session page: nextCursor");
  };
  const decodeSession = (input: unknown, name: string): StatsSession => {
    expectExactRecord(
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
    if (!isRecord(input) || !isRecord(input.device))
      throw new Error(`Invalid session page: ${name}`);
    expectExactRecord(
      input.device,
      ["deviceHandle", "label"],
      `${name}.device`,
    );
    const modality = stringAt(input.modality, `${name}.modality`);
    if (!MODALITIES.has(modality as ActivityModality))
      throw new Error(`Invalid session page: ${name}.modality`);
    const progress = (raw: unknown, field: string): Presence<number> => {
      if (!isRecord(raw) || (raw.kind !== "Absent" && raw.kind !== "Present"))
        throw new Error(`Invalid session page: ${field}`);
      if (raw.kind === "Absent" && Object.keys(raw).length === 1)
        return { kind: "Absent" };
      if (raw.kind === "Present" && Object.keys(raw).length === 2)
        return {
          kind: "Present",
          value: numberAt(raw.value, `${field}.value`),
        };
      throw new Error(`Invalid session page: ${field}`);
    };
    if (
      typeof input.continuesBeforeRange !== "boolean" ||
      typeof input.continuesAfterRange !== "boolean"
    )
      throw new Error(`Invalid session page: ${name}.continues`);
    return {
      ...metrics(input, name),
      mediaRef: mediaRefAt(input.mediaRef, `${name}.mediaRef`),
      title: stringAt(input.title, `${name}.title`),
      modality: modality as ActivityModality,
      device: {
        deviceHandle: deviceHandleAt(
          input.device.deviceHandle,
          `${name}.device.deviceHandle`,
        ),
        label: stringAt(input.device.label, `${name}.device.label`),
      },
      startedAt: instantAt(input.startedAt, `${name}.startedAt`),
      endedAt: instantAt(input.endedAt, `${name}.endedAt`),
      activeMs: numberAt(input.activeMs, `${name}.activeMs`),
      firstProgress: progress(input.firstProgress, `${name}.firstProgress`),
      lastProgress: progress(input.lastProgress, `${name}.lastProgress`),
      continuesBeforeRange: input.continuesBeforeRange,
      continuesAfterRange: input.continuesAfterRange,
    };
  };
  return {
    sessions: array(page.sessions, "sessions").map((item, index) =>
      decodeSession(item, `sessions[${index}]`),
    ),
    nextCursor: decodePresenceString(page.nextCursor),
  };
}

function localDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
