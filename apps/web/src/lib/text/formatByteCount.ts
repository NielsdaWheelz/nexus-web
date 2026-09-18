export function formatByteCount(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1_000;
  let unit: (typeof units)[number] = units[0];
  for (const nextUnit of units.slice(1)) {
    if (value < 1_000) break;
    value /= 1_000;
    unit = nextUnit;
  }
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value)} ${unit}`;
}
