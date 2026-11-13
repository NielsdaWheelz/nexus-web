import { compareStableString, formatDisplayDate } from "@/lib/display/format";

export interface Zone {
  readonly id: string;
  readonly city: string;
  readonly region: string;
}

/** The browser may not know an account zone from the server's newer tzdata. */
export function zoneOf(id: string): Zone {
  try {
    id = new Intl.DateTimeFormat(undefined, { timeZone: id }).resolvedOptions().timeZone;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  const parts = id.replaceAll("_", " ").split("/");
  return { id, city: parts[parts.length - 1], region: parts.slice(0, -1).join(" / ") };
}

export function listZones(always: readonly string[]): readonly Zone[] {
  const supported = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const zones = new Map<string, Zone>();
  for (const id of [...supported, "UTC", ...always]) {
    const zone = zoneOf(id);
    zones.set(zone.id, zone);
  }
  return [...zones.values()].sort((a, b) => compareStableString(a.city, b.city) || compareStableString(a.id, b.id));
}

export function zoneClock(id: string, at: Date, locale: string): { text: string; offset: string } | null {
  try {
    const text = formatDisplayDate(at, { displayLocale: locale, displayTimeZone: id }, {
      weekday: "short", hour: "numeric", minute: "2-digit",
    });
    if (text === null) return null;
    const offset = new Intl.DateTimeFormat(locale, { timeZone: id, timeZoneName: "shortOffset" })
      .formatToParts(at).find(part => part.type === "timeZoneName");
    // justify-defect: requesting timeZoneName requires that part in a successful format.
    if (offset === undefined) throw new Error("zone clock omitted its offset");
    return { text, offset: offset.value };
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}
