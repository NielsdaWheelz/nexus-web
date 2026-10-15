// The search box grammar, shared with Nexus. Tokens are split on whitespace
// outside double quotes; a token `kind|format|author|role|in:<value>` whose value
// is valid becomes a chip, anything else stays text. Pure and total.

import { CONTRIBUTOR_ROLES } from "@/lib/contributors/credits";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { resourceSchemeIsAppSearchScope } from "@/lib/resources/resourceCapabilities";
import {
  normalizeFormat,
  normalizeKind,
  type MediaFormat,
  type SearchKind,
} from "./kinds";

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

const OPERATOR = /^(kind|format|author|role|in):(.*)$/i;

function tokens(raw: string): { token: string; start: number }[] {
  const out: { token: string; start: number }[] = [];
  let quoted = false;
  let start = -1;
  for (let index = 0; index <= raw.length; index++) {
    const char = raw.charAt(index);
    if (char === '"') quoted = !quoted;
    const gap = char === "" || (!quoted && /\s/.test(char));
    if (gap && start >= 0) {
      out.push({ token: raw.slice(start, index), start });
      start = -1;
    } else if (!gap && start < 0) {
      start = index;
    }
  }
  return out;
}

function chipFor(operator: string, raw: string): SearchChip | null {
  const quoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"');
  const value = (quoted ? raw.slice(1, -1) : raw).trim();
  if (!value) return null;
  switch (operator.toLowerCase()) {
    case "kind": {
      const kind = normalizeKind(value);
      return kind && { dim: "kind", value: kind };
    }
    case "format": {
      const format = normalizeFormat(value);
      return format && { dim: "format", value: format };
    }
    case "author":
      return { dim: "author", value };
    case "role": {
      const role = value.toLowerCase();
      return CONTRIBUTOR_ROLES.has(role) ? { dim: "role", value: role } : null;
    }
    default: {
      // in: names an app search scope or a conversation (I7)
      const ref = parseResourceRef(value);
      const scope =
        ref !== null &&
        (resourceSchemeIsAppSearchScope(ref.scheme) ||
          ref.scheme === "conversation");
      return scope ? { dim: "scope", value } : null;
    }
  }
}

export function parseSearchInput(raw: string): ParsedSearchInput {
  const text: string[] = [];
  const chips: SearchChip[] = [];
  for (const { token } of tokens(raw)) {
    const match = OPERATOR.exec(token);
    const chip = match ? chipFor(match[1], match[2]) : null;
    if (chip === null) text.push(token);
    else if (!chips.some((c) => c.dim === chip.dim && c.value === chip.value))
      chips.push(chip);
  }
  return { text: text.join(" "), chips };
}

/**
 * The box once its operators leave it: on a settle while typing (`caret` is the
 * input's) or on Enter (`caret` null). A token that parses to a chip is cut with
 * the space after it (before it, at the end) and the caret moves with the cuts.
 * The operator-shaped token the caret is in or ends is still being typed: it
 * stays in the box and out of `parsed` (Enter holds none).
 */
export function settleSearchBox(
  raw: string,
  caret: number | null,
): { parsed: ParsedSearchInput; box: string; caret: number } {
  let parsed = parseSearchInput(raw);
  let box = raw;
  let at = caret ?? raw.length;
  for (const { token, start } of tokens(raw).reverse()) {
    const end = start + token.length;
    const match = OPERATOR.exec(token);
    if (match === null) continue;
    if (caret !== null && start < caret && caret <= end) {
      parsed = parseSearchInput(raw.slice(0, start) + raw.slice(end));
      continue;
    }
    if (chipFor(match[1], match[2]) === null) continue;
    const to = /\s/.test(box.charAt(end)) ? end + 1 : end;
    const from = to === end && start > 0 ? start - 1 : start;
    box = box.slice(0, from) + box.slice(to);
    at = at >= to ? at - (to - from) : Math.min(at, from);
  }
  return { parsed, box, caret: at };
}
