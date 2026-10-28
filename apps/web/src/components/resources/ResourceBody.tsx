import { excerptTextParts } from "@nexus/authored/excerpt";
import ReaderExcerpt from "./ReaderExcerpt";
import { Fragment } from "react";
import { MediaTitle } from "@/components/media/MediaIdentity";
import type { Schema } from "@/lib/api/wire";
import styles from "./ResourceContent.module.css";

type Excerpt = Schema<"ExcerptOut">;
type Body = Schema<"ResourceItemOut">["preview"]["body"];
export type ResourceMatch = Schema<"SearchMatchOut">;

const hasExcerpt = (excerpt: Excerpt) => Boolean(excerpt.text || excerpt.truncated_before || excerpt.truncated_after);

/** this renderer suppresses separate evidence only for an entire rendered literal. */
export function separateMatchEvidence(body: Body, match: ResourceMatch | null): ResourceMatch | null {
  if (!match?.excerpt.text) return null;
  const text = match.excerpt.text;
  switch (body.kind) {
    case "media":
      // MediaTitle owns canonical title phrasing and cannot render match ranges.
      return match;
    case "named":
      return body.title === text ? null : match;
    case "passage":
      return match;
    case "prose":
      return body.excerpt.text === text ? null : match;
    case "images":
      return body.alts.some(alt => alt?.text === text) ? null : match;
    case "reference":
      return body.label?.text === text ? null : match;
  }
}

/** Omission marks are interface text; the excerpt itself is always literal evidence. */
export function ExcerptText({ excerpt, match }: { excerpt: Excerpt; match?: ResourceMatch | null }) {
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

/** Passive resource content; navigation, editing and graph state belong to callers. */
export default function ResourceBody({ body, match = null, full = false }: { body: Body; match?: ResourceMatch | null; full?: boolean }) {
  const inlineEvidence = Boolean(match?.excerpt.text) && separateMatchEvidence(body, match) === null;
  switch (body.kind) {
    case "media":
      return <span data-resource-primary className={styles.named}><MediaTitle subject={{ kind: "Stored", summary: body.media_summary }} /></span>;
    case "named":
      return <span data-resource-primary data-resource-inline-evidence={inlineEvidence || undefined} className={styles.named}>{body.title ? <ExcerptText excerpt={{ text: body.title, truncated_before: false, truncated_after: false }} match={match} /> : "untitled"}</span>;
    case "passage":
      return <ReaderExcerpt excerpt={body.excerpt} color={body.color} full={full} />;
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

/** One literal line for context and attached-note links. */
export function ResourceIndexBody({ body }: { body: Body }) {
  switch (body.kind) {
    case "media": return <MediaTitle subject={{ kind: "Stored", summary: body.media_summary }} />;
    case "named": return body.title || "untitled";
    case "passage": return body.excerpt.kind === "content" ? <ExcerptText excerpt={{ text: excerptTextParts(body.excerpt.body).exact || "selected region", truncated_before: body.excerpt.selected_truncated_before, truncated_after: body.excerpt.selected_truncated_after }} /> : "table excerpt";
    case "prose": return <span className={body.format === "code" ? styles.code : undefined} style={{ whiteSpace: "inherit" }}>
      {hasExcerpt(body.excerpt) ? <ExcerptText excerpt={body.excerpt} /> : "empty note"}
      {body.image_count > 0 ? <span className={styles.bodyCount}> · {body.image_count === 1 ? "image" : `${body.image_count} images`}</span> : null}
    </span>;
    case "images": {
      const alt = body.alts.find(value => value !== null && hasExcerpt(value));
      return alt ? <ExcerptText excerpt={alt} /> : body.count === 1 ? "image" : `${body.count} images`;
    }
    case "reference": return body.label && hasExcerpt(body.label) ? <ExcerptText excerpt={body.label} /> : body.target_ref;
  }
}

/** Distinct literal evidence keeps its own omission marks and codepoint ranges. */
export function ResourceMatchEvidence({ match }: { match: ResourceMatch }) {
  return <div className={styles.matchEvidence}><ExcerptText excerpt={match.excerpt} match={match} /></div>;
}
