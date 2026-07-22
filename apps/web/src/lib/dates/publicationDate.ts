import { absent, present, type Presence } from "@/lib/api/presence";

declare const PUBLICATION_DATE: unique symbol;

/** A real partial ISO date or ISO 8601 instant, checked at a source boundary. */
export type PublicationDate = string & {
  readonly [PUBLICATION_DATE]: true;
};

const YEAR = /^(\d{4})$/;
const YEAR_MONTH = /^(\d{4})-(\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRealDate(year: string, month = "01", day = "01"): boolean {
  if (year === "0000") return false;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === `${year}-${month}-${day}`
  );
}

/**
 * Accept the wire grammars Nexus actually owns: partial ISO dates
 * (YYYY / YYYY-MM / YYYY-MM-DD) and timezone-qualified ISO instants.
 */
export function decodePublicationDate(
  raw: unknown,
  name: string,
): PublicationDate {
  if (typeof raw !== "string") {
    throw new TypeError(`${name} must be a publication date string`);
  }
  const year = YEAR.exec(raw);
  if (year !== null && isRealDate(year[1])) return raw as PublicationDate;

  const month = YEAR_MONTH.exec(raw);
  if (month !== null && isRealDate(month[1], month[2])) {
    return raw as PublicationDate;
  }

  const date = DATE.exec(raw);
  if (date !== null && isRealDate(date[1], date[2], date[3])) {
    return raw as PublicationDate;
  }

  const instant = INSTANT.exec(raw);
  if (
    instant !== null &&
    isRealDate(instant[1], instant[2], instant[3]) &&
    Number(instant[4]) <= 23 &&
    Number(instant[5]) <= 59 &&
    Number(instant[6]) <= 59 &&
    !Number.isNaN(Date.parse(raw))
  ) {
    return raw as PublicationDate;
  }

  throw new TypeError(
    `${name} must be a real YYYY, YYYY-MM, YYYY-MM-DD, or ISO 8601 instant`,
  );
}

export function decodeOptionalPublicationDate(
  raw: unknown,
  name: string,
): Presence<PublicationDate> {
  return raw === null ? absent() : present(decodePublicationDate(raw, name));
}
