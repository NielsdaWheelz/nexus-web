// Pure render-time derivation of a dossier's opening abstract (the collapsed
// brief lede). No network, no new backend field (machine-output-in-place N4) —
// the lede is the artifact's own `content_md`, reduced to its first prose
// paragraph and stripped to plain text for the machine-voice register.

const MAX_LEDE_WORDS = 50;
const MAX_LEDE_CHARS = 320;

function stripBlockMarks(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s{0,3}>\s?/, "")
    .replace(/^\s{0,3}([-*+]|\d+\.)\s+/, "");
}

function stripInlineMarks(input: string): string {
  return input
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]+/g, "");
}

function stripParagraph(paragraph: string): string {
  const joined = paragraph
    .split("\n")
    .map((line) => stripBlockMarks(line.trim()))
    .join(" ");
  return stripInlineMarks(joined).replace(/\s+/g, " ").trim();
}

function truncate(text: string): string {
  const words = text.split(/\s+/);
  let result = words.length > MAX_LEDE_WORDS ? words.slice(0, MAX_LEDE_WORDS).join(" ") : text;
  if (result.length > MAX_LEDE_CHARS) {
    const clipped = result.slice(0, MAX_LEDE_CHARS);
    const lastSpace = clipped.lastIndexOf(" ");
    result = (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trim();
  }
  if (result.length < text.length) {
    return `${result.replace(/[.,;:!?]+$/, "")}…`;
  }
  return result;
}

/**
 * The dossier's opening abstract: the first non-empty prose paragraph of
 * `contentMd`, stripped of heading/emphasis/link marks and truncated to ~50
 * words / 320 chars at a word boundary. Pure-heading blocks are skipped in
 * favour of prose; a heading is only used when the whole document is headings.
 * Returns `""` for empty/whitespace input.
 */
export function deriveDossierLede(contentMd: string): string {
  const paragraphs = (contentMd ?? "").split(/\n\s*\n/);
  let headingFallback = "";
  for (const paragraph of paragraphs) {
    const stripped = stripParagraph(paragraph);
    if (stripped.length === 0) continue;
    if (paragraph.trim().startsWith("#")) {
      if (headingFallback.length === 0) headingFallback = stripped;
      continue;
    }
    return truncate(stripped);
  }
  return headingFallback.length > 0 ? truncate(headingFallback) : "";
}
