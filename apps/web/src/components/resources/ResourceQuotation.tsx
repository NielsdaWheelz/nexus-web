import { ContributorCreditList } from "@/components/contributors/ContributorCredits";
import { excerptView } from "@nexus/authored/excerpt";
import type { SelectionCapture } from "@nexus/authored/types";
import type { Schema } from "@/lib/api/wire";
import { assertNever } from "@/lib/assertNever";
import { creditName, selectMediaAuthors, type ContributorCredit } from "@/lib/contributors/credits";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { itemMediaKind, resourceType, resourceTypeName } from "@/lib/resources/type";
import ResourceBody from "./ResourceBody";
import ResourceLink from "./ResourceLink";
import ReaderExcerpt from "./ReaderExcerpt";
import { ResourceTypeIcon } from "./ResourceType";
import styles from "./ResourceQuotation.module.css";
import linkStyles from "./ResourceLink.module.css";

export type ResourceQuotationCapture = Readonly<{
  capture: SelectionCapture;
  source: Pick<Schema<"SourceAttributionOut">, "ref" | "title" | "media_kind" | "contributors" | "location_label">;
  href: string | null;
}>;

/** Supplied evidence and attribution; navigation never replaces captured content. */
export default function ResourceQuotation(props: { item: Schema<"ResourceItemOut"> } | ResourceQuotationCapture) {
  const item = "item" in props ? props.item : null;
  const body = item?.preview.body ?? null;
  const source = "item" in props ? props.item.preview.source : props.source;
  if (item?.missing && body?.kind === "named" && source === null
    && item.activation.unavailable_reason === "source_unavailable") {
    return <figure className={styles.quotation}><ResourceLink item={item} /></figure>;
  }

  let identity: { title: string; contributors: readonly ContributorCredit[] | null } | null = null;
  if (body !== null) switch (body.kind) {
    case "named":
      identity = { title: body.title, contributors: body.contributors };
      break;
    case "media":
      identity = { title: body.media_summary.title, contributors: body.media_summary.contributors };
      break;
    case "passage":
    case "prose":
    case "images":
    case "reference":
      identity = null;
      break;
    default:
      assertNever(body);
  }
  const attributedRef = source ? source.ref ? parseResourceRef(source.ref) : null : item ? parseResourceRef(item.ref) : null;
  const type = attributedRef ? resourceType(attributedRef.scheme, item ? itemMediaKind(item) : source?.media_kind ?? null) : null;
  const sourceTitle = source
    ? source.title?.trim() ? source.title : "untitled"
    : type ? resourceTypeName(type) : "source";
  const title = identity ? identity.title.trim() ? identity.title : "untitled" : sourceTitle;
  const authors = selectMediaAuthors(identity ? identity.contributors ?? [] : source?.contributors ?? [])
    .filter(credit => creditName(credit) !== null);
  const distinctSource = identity !== null && source !== null && item !== null && source.ref !== item.ref;
  const sourceAuthors = selectMediaAuthors(distinctSource ? source.contributors ?? [] : [])
    .filter(credit => creditName(credit) !== null);
  // With neither identity nor source the title is the noun itself, so it takes no prefix.
  const glyph = type ? <span className={styles.glyph}>
    <ResourceTypeIcon type={type} />
    {identity === null && source === null ? null : <span className="sr-only">{resourceTypeName(type)}: </span>}
  </span> : null;
  const role = body?.kind === "prose" && body.role?.trim() ? body.role : null;
  const content = "capture" in props
    ? <ReaderExcerpt excerpt={excerptView(props.capture.excerpt, "full", { kind: "capture" })} color={null} full />
    : body !== null ? <ResourceBody body={body} full /> : null;

  return <figure className={styles.quotation}>
    {identity === null ? body?.kind === "passage" || "capture" in props
      ? <blockquote className={styles.body}>{content}</blockquote>
      : <div className={styles.body}>{content}</div> : null}
    <figcaption className={styles.attribution}>
      <div className={styles.identity}>
        {!distinctSource ? glyph : null}
        <span className={styles.identityText}>
          {item !== null ? <ResourceLink item={item} label={title} />
            : "href" in props && props.href !== null ? <a className={linkStyles.link} href={props.href} data-pane-label-hint={title}>{title}</a> : title}
          {authors.length > 0 ? <> — <ContributorCreditList credits={authors} maxVisible={authors.length} /></> : null}
          {!distinctSource && source?.location_label?.trim() ? <> · {source.location_label}</> : null}
          {role ? <> · {role}</> : null}
        </span>
      </div>
      {distinctSource ? <div className={styles.identity}>
        {glyph}
        <span className={styles.identityText}>
          {sourceTitle}
          {sourceAuthors.length > 0 ? <> — <ContributorCreditList credits={sourceAuthors} maxVisible={sourceAuthors.length} /></> : null}
          {source.location_label?.trim() ? <> · {source.location_label}</> : null}
        </span>
      </div> : null}
    </figcaption>
  </figure>;
}
