import { Fragment } from "react";
import type { Schema } from "@/lib/api/wire";
import styles from "./ResourceOutline.module.css";

type Excerpt = Schema<"ExcerptOut">;
type Body = Schema<"ResourceItemOut">["preview"]["body"];
export type ResourceMatch = Schema<"SearchMatchOut">;

const hasExcerpt = (excerpt: Excerpt) => Boolean(excerpt.text || excerpt.truncated_before || excerpt.truncated_after);

/** this renderer suppresses separate evidence only for an entire rendered literal. */
export function separateMatchEvidence(body: Body, match: ResourceMatch | null): ResourceMatch | null {
  if (!match?.excerpt.text) return null;
  const text = match.excerpt.text;
  switch (body.kind) {
    case "named":
      return body.title === text ? null : match;
    case "passage":
      return body.exact.text === text
        || (body.prefix?.text === text && !body.exact.truncated_before)
        || (body.suffix?.text === text && !body.exact.truncated_after) ? null : match;
    case "prose":
      return body.excerpt.text === text ? null : match;
    case "images":
      return body.alts.some(alt => alt?.text === text) ? null : match;
    case "reference":
      return body.label?.text === text ? null : match;
  }
}

/** Omission marks are interface text; the excerpt itself is always literal evidence. */
function ExcerptText({ excerpt, match }: { excerpt: Excerpt; match?: ResourceMatch | null }) {
  const text = excerpt.text;
  const ranges = match?.excerpt.text === text ? match.ranges : [];
  const points = Array.from(text);
  let end = 0;
  const pieces = ranges.map((range) => {
    const before = points.slice(end, range.start).join("");
    end = range.end;
    return <Fragment key={`${range.start}:${range.end}`}>{before}<span className={styles.match}>{points.slice(range.start, range.end).join("")}</span></Fragment>;
  });
  return <>
    {excerpt.truncated_before ? <span aria-label="earlier text omitted">…</span> : null}
    {ranges.length ? <>{pieces}{points.slice(end).join("")}</> : text}
    {excerpt.truncated_after ? <span aria-label="later text omitted">…</span> : null}
  </>;
}

/** Literal phrasing content; navigation, editing and graph state belong to callers. */
export default function ResourceBody({ body, match = null }: { body: Body; match?: ResourceMatch | null }) {
  const inlineEvidence = Boolean(match?.excerpt.text) && separateMatchEvidence(body, match) === null;
  switch (body.kind) {
    case "named":
      return <span data-resource-primary data-resource-inline-evidence={inlineEvidence || undefined} className={styles.named}>{body.title ? <ExcerptText excerpt={{ text: body.title, truncated_before: false, truncated_after: false }} match={match} /> : "untitled"}</span>;
    case "passage":
      return <span data-resource-primary data-resource-inline-evidence={inlineEvidence || undefined} className={styles.passage}>
        {body.prefix && !body.exact.truncated_before ? <span className={styles.context}><ExcerptText excerpt={body.prefix} match={match} /></span> : null}
        {hasExcerpt(body.exact) ? <mark className={styles.exact} data-color={body.color ?? undefined}><ExcerptText excerpt={body.exact} match={match} /></mark> : <mark className={styles.exact} data-color={body.color ?? undefined}>selected region</mark>}
        {body.suffix && !body.exact.truncated_after ? <span className={styles.context}><ExcerptText excerpt={body.suffix} match={match} /></span> : null}
      </span>;
    case "prose":
      return <>
        <span data-resource-primary data-resource-inline-evidence={inlineEvidence || undefined} className={body.format === "code" ? styles.code : styles.prose}>
          {hasExcerpt(body.excerpt) ? <ExcerptText excerpt={body.excerpt} match={match} /> : <span className={styles.quiet}>no text</span>}
        </span>
        {body.image_count > 0 ? <><br /><span className={styles.bodyCount}>{body.image_count === 1 ? "image" : `${body.image_count} images`}</span></> : null}
      </>;
    case "images":
      return <span data-resource-primary data-resource-inline-evidence={inlineEvidence || undefined} className={styles.prose}>
        <span className={styles.quiet}>{body.count === 1 ? "image" : `${body.count} images`}</span>
        {body.alts.map((alt, index) => alt && hasExcerpt(alt) ? <Fragment key={index}><br /><ExcerptText excerpt={alt} match={match} /></Fragment> : null)}
      </span>;
    case "reference":
      return <span data-resource-primary data-resource-inline-evidence={inlineEvidence || undefined} className={styles.prose}>{body.label && hasExcerpt(body.label) ? <><span className={styles.quiet}>reference · </span><ExcerptText excerpt={body.label} match={match} /></> : "embedded resource"}</span>;
  }
}

/** Distinct literal evidence keeps its own omission marks and codepoint ranges. */
export function ResourceMatchEvidence({ match }: { match: ResourceMatch }) {
  return <div className={styles.matchEvidence}><ExcerptText excerpt={match.excerpt} match={match} /></div>;
}
