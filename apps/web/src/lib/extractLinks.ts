/**
 * The one link parser: the links in typed, pasted or shared text, in order and without
 * repeats, and the text that held none. Whitespace separates; urls glued together split
 * where a scheme starts, unless a `/`, `=` or `%` precedes it, as in a redirect parameter;
 * trailing punctuation and unbalanced closing brackets are prose, not url. A link is
 * returned as first written; a repeat is one that parses to the same url, so
 * `https://a.com` and `https://A.com/` are one. `UrlsOrSoleDomain`, the import field's rule
 * alone, also reads a bare domain as its https url when it is the text's only token: in a
 * list or prose, `README.md` and `Node.js` are words.
 */
export function extractLinks(text: string, accept: "Urls" | "UrlsOrSoleDomain"): { links: string[]; rest: string } {
  const tokens = text.split(/\s+/).filter(token => token !== "");
  if (accept === "UrlsOrSoleDomain" && tokens.length === 1) {
    const domain = trimProse(tokens[0]!);
    if (BARE_DOMAIN.test(domain) && isHttpUrl(`https://${domain}`)) return { links: [`https://${domain}`], rest: "" };
  }
  const links: string[] = [];
  const rest: string[] = [];
  const seen = new Set<string>();
  const keep = (link: string) => {
    const url = new URL(link).href;
    if (seen.has(url)) return;
    seen.add(url);
    links.push(link);
  };
  for (const token of tokens) {
    const starts = [...token.matchAll(/https?:\/\//gi)].map(match => match.index)
      .filter(index => index === 0 || !"/=%".includes(token[index - 1]!));
    if (starts.length === 0) {
      rest.push(token);
      continue;
    }
    if (starts[0]! > 0) rest.push(token.slice(0, starts[0]));
    starts.forEach((start, index) => {
      const raw = token.slice(start, starts[index + 1] ?? token.length);
      const link = trimProse(raw);
      if (isHttpUrl(link)) keep(link);
      else rest.push(raw);
    });
  }
  return { links, rest: rest.join(" ") };
}

const BARE_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?::\d+)?(?:[/?#]\S*)?$/i;
const OPENER: Readonly<Partial<Record<string, string>>> = { ")": "(", "]": "[", "}": "{", ">": "<" };
const count = (text: string, char: string) => text.split(char).length - 1;

function trimProse(token: string): string {
  let end = token.length;
  while (end > 0) {
    const last = token[end - 1]!;
    const opener = OPENER[last];
    const body = token.slice(0, end);
    if (!".,;:!?'\"".includes(last) && (opener === undefined || count(body, opener) >= count(body, last))) break;
    end -= 1;
  }
  return token.slice(0, end);
}

/** An absolute http(s) url with a host right after its slashes; URL would repair the rest. */
function isHttpUrl(text: string): boolean {
  if (!/^https?:\/\/[^/?#\\]/i.test(text)) return false;
  try {
    return new URL(text).hostname !== "";
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}
