export type ReaderTargetKind =
  | "evidence"
  | "fragment"
  | "highlight"
  | "page"
  | "loc"
  | "t";

export interface ReaderTarget {
  kind: ReaderTargetKind;
  value: string;
  origin: "hash" | "pulse" | "manual";
}

const KINDS: readonly ReaderTargetKind[] = [
  "evidence",
  "fragment",
  "highlight",
  "page",
  "loc",
  "t",
];

export function parseReaderTargetHash(
  hash: string,
): { kind: ReaderTargetKind; value: string } | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const dash = raw.indexOf("-");
  if (dash <= 0 || dash === raw.length - 1) return null;
  const kind = raw.slice(0, dash);
  const value = raw.slice(dash + 1);
  if (!KINDS.includes(kind as ReaderTargetKind)) return null;
  if (value.length === 0 || /\s/.test(value)) return null;
  if (kind === "page") {
    if (!/^[0-9]+$/.test(value) || value === "0") return null;
  } else if (kind === "t") {
    if (!/^[0-9]+$/.test(value)) return null;
  }
  return { kind: kind as ReaderTargetKind, value };
}
