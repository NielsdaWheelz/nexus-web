// One comparator for every stream: the name tier, the latch, the canonical href and frecency.
// Pure and total; no rows, react or network.
import type { NexusStream, RankTier, UsageMap } from "./model";
import { LATCH_USES } from "./policy";

const TIERS: readonly RankTier[] = ["ExplicitIntent", "Latched", "Exact", "PrefixOrToken", "Abbreviation", "Substring", "Lexical", "Semantic"];
const STREAMS: readonly NexusStream[] = ["Navigation", "Local", "Recent", "Resources", "Saved", "Passages"];

/** What the comparator reads; every row carries it. */
export interface Ranked {
  readonly key: string;
  readonly rank: { readonly tier: RankTier; readonly stream: NexusStream };
  readonly frecency: number;
  readonly recency: number;
}

/** Tier, then frecency, recency, stream and key: deterministic for equal inputs. */
export function compareRank(a: Ranked, b: Ranked): number {
  return TIERS.indexOf(a.rank.tier) - TIERS.indexOf(b.rank.tier)
    || b.frecency - a.frecency
    || b.recency - a.recency
    || STREAMS.indexOf(a.rank.stream) - STREAMS.indexOf(b.rank.stream)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** How a query matches a name: bylines count only as Substring; hrefs never count. */
export function nameTier(query: string, name: string, keywords: readonly string[]): RankTier | null {
  const text = query.trim().toLowerCase();
  const label = name.trim().toLowerCase();
  if (label === text) return "Exact";
  if (label.startsWith(text) || label.split(/\s+/).some(token => token.startsWith(text))) return "PrefixOrToken";
  if (abbreviation(text, label) !== null) return "Abbreviation";
  if (label.includes(text) || keywords.some(keyword => keyword.trim().toLowerCase().includes(text))) return "Substring";
  return null;
}

const WORD = /[\p{L}\p{N}]/u;
const boundary = (label: string, at: number) => at === 0 || !WORD.test(label[at - 1]!);

/**
 * fzf constants: match 16, boundary +8, consecutive +4, gap −3−n, first ×2. Every gap must land on a
 * word boundary and the score must reach max(24, 14 × length); the score, else null.
 */
export function abbreviation(query: string, label: string): number | null {
  const text = query.trim().toLowerCase();
  const name = label.trim().toLowerCase();
  if (!text) return null;
  let cursor = 0;
  let score = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    let at = index > 0 && name[cursor] === char ? cursor : -1;
    for (let candidate = cursor; at < 0 && candidate < name.length; candidate++) if (name[candidate] === char && boundary(name, candidate)) at = candidate;
    if (at < 0) return null;
    const gap = at - cursor;
    const gained = (16 + (boundary(name, at) ? 8 : 0) + (index > 0 && gap === 0 ? 4 : 0)) * (index === 0 ? 2 : 1);
    score += gained - (gap > 0 ? 3 + gap : 0);
    cursor = at + 1;
  }
  return score >= Math.max(24, 14 * text.length) ? score : null;
}

/** The server's `_normalize_query`: lowercase, one space between words, 200 characters. */
export function normalizeQuery(query: string | null): string {
  return (query ?? "").toLowerCase().split(/\s+/).filter(Boolean).join(" ").slice(0, 200).trim();
}

const unquote = (value: string): string => { try { return decodeURIComponent(value); } catch { return value; } };
/** python's `quote_plus(value, safe="")`. */
const quotePlus = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, "+");
/** python's `quote(value, safe="!$&'()*+,-./:;=?@_~")`. */
const quoteFragment = (value: string): string => encodeURIComponent(value).replace(/%(24|26|2B|2C|2F|3A|3B|3D|3F|40)/g, escaped => decodeURIComponent(escaped));

/**
 * The mirror of `nexus_ranking.py:_canonical_href`: trim, strip trailing slashes beyond `/`, sort the
 * query pairs, requote the fragment; media paths keep only their path. The server stores this form, so
 * `remember` and the latch lookup meet on it.
 */
export function canonicalHref(href: string): string {
  const trimmed = href.trim();
  const hashAt = trimmed.indexOf("#");
  const beforeHash = hashAt < 0 ? trimmed : trimmed.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const rawPath = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
  if (path.split("/")[1] === "media") return path;
  const pairs = (queryAt < 0 ? "" : beforeHash.slice(queryAt + 1)).split("&").filter(Boolean).map(pair => {
    const equals = pair.indexOf("=");
    const [key, value] = equals < 0 ? [pair, ""] : [pair.slice(0, equals), pair.slice(equals + 1)];
    return [unquote(key.replace(/\+/g, " ")), unquote(value.replace(/\+/g, " "))] as const;
  });
  const query = pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([key, value]) => `${quotePlus(key)}=${quotePlus(value)}`).join("&");
  const fragment = hashAt < 0 ? "" : quoteFragment(unquote(trimmed.slice(hashAt + 1)));
  return path + (query ? `?${query}` : "") + (fragment ? `#${fragment}` : "");
}

/**
 * Law 5: a target chosen LATCH_USES times or more under a typed string owns every query that is a prefix
 * of it or that it is a prefix of. The longest string wins, then the higher use_count × points, then the
 * newer last_used, then the lexically smaller href.
 */
export function latchedHref(queryNormalized: string, map: UsageMap): string | null {
  if (!queryNormalized) return null;
  let best: { readonly query: string; readonly product: number; readonly lastUsed: string; readonly href: string } | null = null;
  for (const [query, targets] of Object.entries(map)) {
    if (!query || !(query.startsWith(queryNormalized) || queryNormalized.startsWith(query))) continue;
    for (const [href, use] of Object.entries(targets)) {
      if (use.use_count < LATCH_USES) continue;
      const candidate = { query, product: use.use_count * use.points, lastUsed: use.last_used, href };
      const better = best === null || query.length > best.query.length || query.length === best.query.length && (
        candidate.product > best.product || candidate.product === best.product && (
          candidate.lastUsed > best.lastUsed || candidate.lastUsed === best.lastUsed && href < best.href));
      if (better) best = candidate;
    }
  }
  return best?.href ?? null;
}

/** The untyped aggregate's use_count × points, scaled v / (v + 100); 0 when unseen. */
export function frecency(href: string, map: UsageMap): number {
  const use = map[""]?.[canonicalHref(href)];
  if (!use) return 0;
  const value = use.use_count * use.points;
  return value / (value + 100);
}
