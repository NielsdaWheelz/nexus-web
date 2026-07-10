/**
 * Colophon — the printer's mark of honest provenance.
 *
 * Renders model · tokens · cost · sources below completed assistant turns.
 * Pure display — no interactivity. Only shown when status is "complete" and
 * the run data is present (see AssistantMessage.tsx gating).
 *
 * Lives inside the MachineText block and inherits the machine register
 * font and ink tokens from the enclosing wrapper.
 */

import styles from "./Colophon.module.css";

// ---------------------------------------------------------------------------
// Formatting helpers (exported for unit testing — Colophon.test.ts)
// ---------------------------------------------------------------------------

/** Uppercase model name. Empty/null → empty string (segment omitted). */
export function formatColophonModel(modelName: string | null | undefined): string {
  if (!modelName) return "";
  return modelName.toUpperCase();
}

/**
 * Format token counts as "Xk" shorthand or plain number.
 * Returns empty string when both are null (segment omitted).
 * When one is non-null, both render (the null one as "—").
 */
export function formatColophonTokens(
  inputTokens: number | null,
  outputTokens: number | null,
): string {
  if (inputTokens === null && outputTokens === null) return "";
  const fmt = (n: number | null): string => {
    if (n === null) return "—";
    if (n >= 1000) return `${(Math.round(n / 100) / 10).toFixed(1)}K`;
    return String(n);
  };
  return `${fmt(inputTokens)} IN / ${fmt(outputTokens)} OUT`;
}

/**
 * Format cost in USD micros to "$X.XXX".
 * Returns empty string when null (segment omitted).
 */
export function formatColophonCost(totalCostUsdMicros: number | null): string {
  if (totalCostUsdMicros === null) return "";
  const usd = totalCostUsdMicros / 1_000_000;
  return `$${usd.toFixed(3)}`;
}

/** Format source count ("N SOURCE" / "N SOURCES"). Omits when 0. */
export function formatColophonSources(sourceCount: number): string {
  if (sourceCount === 0) return "";
  return `${sourceCount} ${sourceCount === 1 ? "SOURCE" : "SOURCES"}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ColophonProps {
  modelName: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalCostUsdMicros: number | null;
  sourceCount: number;
}

export default function Colophon({
  modelName,
  inputTokens,
  outputTokens,
  totalCostUsdMicros,
  sourceCount,
}: ColophonProps) {
  const segments = [
    formatColophonModel(modelName),
    formatColophonTokens(inputTokens, outputTokens),
    formatColophonCost(totalCostUsdMicros),
    formatColophonSources(sourceCount),
  ].filter(Boolean);

  if (segments.length === 0) return null;

  return (
    <div className={styles.colophon} aria-label="Generation provenance">
      {segments.join(" · ")}
    </div>
  );
}
