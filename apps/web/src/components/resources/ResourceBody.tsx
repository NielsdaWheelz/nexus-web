import { Fragment } from "react";
import type { Schema } from "@/lib/api/wire";
import styles from "./ResourceOutline.module.css";

type Excerpt = Schema<"ExcerptOut">;
type Body = Schema<"ResourceItemOut">["preview"]["body"];
export type ResourceMatch = Schema<"SearchMatchOut">;

const hasExcerpt = (excerpt: Excerpt) => Boolean(excerpt.text || excerpt.truncated_before || excerpt.truncated_after);

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
  switch (body.kind) {
    case "named":
      return <span data-resource-primary className={styles.named}>{body.title || "untitled"}</span>;
    case "passage":
      return <span data-resource-primary className={styles.passage}>
        {body.prefix && !body.exact.truncated_before ? <span className={styles.context}><ExcerptText excerpt={body.prefix} /></span> : null}
        {hasExcerpt(body.exact) ? <mark className={styles.exact} data-color={body.color ?? undefined}><ExcerptText excerpt={body.exact} match={match} /></mark> : <mark className={styles.exact} data-color={body.color ?? undefined}>selected region</mark>}
        {body.suffix && !body.exact.truncated_after ? <span className={styles.context}><ExcerptText excerpt={body.suffix} /></span> : null}
      </span>;
    case "prose":
      return <>
        <span data-resource-primary className={body.format === "code" ? styles.code : styles.prose}>
          {hasExcerpt(body.excerpt) ? <ExcerptText excerpt={body.excerpt} match={match} /> : <span className={styles.quiet}>no text</span>}
        </span>
        {body.image_count > 0 ? <><br /><span className={styles.bodyCount}>{body.image_count === 1 ? "image" : `${body.image_count} images`}</span></> : null}
      </>;
    case "images":
      return <span data-resource-primary className={styles.prose}>
        <span className={styles.quiet}>{body.count === 1 ? "image" : `${body.count} images`}</span>
        {body.alts.map((alt, index) => alt && hasExcerpt(alt) ? <Fragment key={index}><br /><ExcerptText excerpt={alt} /></Fragment> : null)}
      </span>;
    case "reference":
      return <span data-resource-primary className={styles.prose}>{body.label && hasExcerpt(body.label) ? <><span className={styles.quiet}>reference · </span><ExcerptText excerpt={body.label} /></> : "embedded resource"}</span>;
  }
}

/** A named search hit may have separate evidence; passage hits render it only once. */
export function ResourceMatchEvidence({ match }: { match: ResourceMatch }) {
  return <div className={styles.matchEvidence}><ExcerptText excerpt={match.excerpt} match={match} /></div>;
}
