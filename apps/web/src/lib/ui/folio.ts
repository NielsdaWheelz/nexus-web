// The typed folio — the single per-surface signal a running head carries
// flush-right (a count, a date, or the title of what you're reading). It is a
// small typed contract, never a free-form node, so it can never grow into a
// stats dashboard. Domain-free and React-free: RunningHead (a kit primitive on
// the boundary allowlist) imports it without tripping the primitive guard.

export type Folio =
  | { kind: "count"; value: number; unit: string }
  | { kind: "date"; iso: string }
  | { kind: "title"; value: string }
  | { kind: "none" };

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "numeric",
  month: "short",
};

function pluralize(unit: string, value: number): string {
  if (value === 1) return unit;
  if (/(s|x|z|ch|sh)$/.test(unit)) return `${unit}es`;
  if (/[^aeiou]y$/.test(unit)) return `${unit.slice(0, -1)}ies`;
  return `${unit}s`;
}

/**
 * Format a folio for display. `count` renders in tabular figures (styled by the
 * running head, not here); `date` renders a short weekday+day+month in the
 * viewer locale; `title` passes through (truncation is CSS's job); `none`
 * renders nothing.
 */
export function formatFolio(folio: Folio): string | null {
  switch (folio.kind) {
    case "count":
      return `${folio.value.toLocaleString()} ${pluralize(folio.unit, folio.value)}`;
    case "date": {
      // Parse a date-only ISO as a local date so the weekday/day never drift
      // across time zones.
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(folio.iso);
      if (!match) return null;
      const [, year, month, day] = match;
      const date = new Date(Number(year), Number(month) - 1, Number(day));
      if (Number.isNaN(date.getTime())) return null;
      return new Intl.DateTimeFormat(undefined, DATE_FORMAT).format(date);
    }
    case "title":
      return folio.value;
    case "none":
      return null;
  }
}
