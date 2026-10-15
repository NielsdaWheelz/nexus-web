// A web search result's publication date arrives as its provider sent it. Every other
// bibliography date is the server's PublicationDate (YYYY, YYYY-MM or YYYY-MM-DD) already.

const PARTIAL = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRealDate(year: string, month = "01", day = "01"): boolean {
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return (
    year !== "0000" &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === `${year}-${month}-${day}`
  );
}

/** A real partial date or a qualified instant as given; anything else is no date. */
export function decodeWebPublicationDate(raw: string | null): string | null {
  if (raw === null) return null;
  const partial = PARTIAL.exec(raw);
  if (partial !== null)
    return isRealDate(partial[1], partial[2], partial[3]) ? raw : null;
  const instant = INSTANT.exec(raw);
  const real =
    instant !== null &&
    isRealDate(instant[1], instant[2], instant[3]) &&
    Number(instant[4]) <= 23 &&
    Number(instant[5]) <= 59 &&
    Number(instant[6]) <= 59;
  return real ? raw : null;
}
