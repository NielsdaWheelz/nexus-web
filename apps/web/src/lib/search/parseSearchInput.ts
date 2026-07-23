// Pure operator parser for the search box (search cutover §7.2). Tokenizes raw
// input honoring quotes; a token matching a closed operator set with a valid value
// becomes a filter chip, anything else stays free text. No throw, async, or network.

import { CONTRIBUTOR_ROLES } from "@/lib/contributors/vocab";
import {
  normalizeFormat,
  normalizeKind,
  type MediaFormat,
  type SearchKind,
} from "./kinds";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { resourceSchemeIsAppSearchScope } from "@/lib/resources/resourceCapabilities";

export type SearchChip =
  | { dim: "kind"; value: SearchKind }
  | { dim: "format"; value: MediaFormat }
  | { dim: "author"; value: string }
  | { dim: "role"; value: string }
  | { dim: "scope"; value: string };

export interface ParsedSearchInput {
  text: string;
  chips: SearchChip[];
}

const OPERATOR_RE = /^(kind|format|author|role|in):(.+)$/i;

function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  for (const char of raw) {
    if (char === '"') {
      inQuote = !inQuote;
      current += char;
      continue;
    }
    if (/\s/.test(char) && !inQuote) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function chipFor(operator: string, rawValue: string): SearchChip | null {
  const value = stripQuotes(rawValue);
  if (!value) return null;
  switch (operator.toLowerCase()) {
    case "kind": {
      const kind = normalizeKind(value);
      return kind ? { dim: "kind", value: kind } : null;
    }
    case "format": {
      const format = normalizeFormat(value);
      return format ? { dim: "format", value: format } : null;
    }
    case "author":
      return { dim: "author", value };
    case "role": {
      const role = value.toLowerCase();
      return CONTRIBUTOR_ROLES.has(role) ? { dim: "role", value: role } : null;
    }
    case "in":
      return isSearchScope(value) ? { dim: "scope", value } : null;
    default:
      return null;
  }
}

function isSearchScope(value: string): boolean {
  const ref = parseResourceRef(value);
  return (
    ref !== null &&
    (resourceSchemeIsAppSearchScope(ref.scheme) ||
      ref.scheme === "conversation")
  );
}

function dedupeChips(chips: SearchChip[]): SearchChip[] {
  const seen = new Set<string>();
  const out: SearchChip[] = [];
  for (const chip of chips) {
    const key = `${chip.dim}:${chip.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(chip);
  }
  return out;
}

export function parseSearchInput(raw: string): ParsedSearchInput {
  const textParts: string[] = [];
  const chips: SearchChip[] = [];
  for (const token of tokenize(raw)) {
    const match = OPERATOR_RE.exec(token);
    const chip = match ? chipFor(match[1], match[2]) : null;
    if (chip) {
      chips.push(chip);
    } else {
      textParts.push(token);
    }
  }
  return { text: textParts.join(" ").trim(), chips: dedupeChips(chips) };
}
