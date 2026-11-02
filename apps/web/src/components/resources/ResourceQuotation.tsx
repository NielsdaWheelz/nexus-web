import { ContributorCreditList } from "@/components/contributors/ContributorCredits";
import type { Schema } from "@/lib/api/wire";
import { assertNever } from "@/lib/assertNever";
import { creditName, selectMediaAuthors, type ContributorCredit } from "@/lib/contributors/credits";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { itemMediaKind, resourceType, resourceTypeName } from "@/lib/resources/type";
import ResourceBody from "./ResourceBody";
import ResourceLink from "./ResourceLink";
import { ResourceTypeIcon } from "./ResourceType";
import styles from "./ResourceQuotation.module.css";

/** Supplied evidence and attribution; navigation never replaces captured content. */
export default function ResourceQuotation({ item }: { item: Schema<"ResourceItemOut"> }) {
  const { body, source } = item.preview;
  if (item.missing && body.kind === "named" && source === null
    && item.activation.unavailable_reason === "source_unavailable") {
    return <figure className={styles.quotation}><ResourceLink item={item} /></figure>;
  }

  let identity: { title: string; contributors: readonly ContributorCredit[] | null } | null;
  switch (body.kind) {
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
  const attributedRef = source ? source.ref ? parseResourceRef(source.ref) : null : parseResourceRef(item.ref);
  const type = attributedRef ? resourceType(attributedRef.scheme, itemMediaKind(item)) : null;
  const sourceTitle = source
    ? source.title?.trim() ? source.title : "untitled"
    : type ? resourceTypeName(type) : "source";
  const title = identity ? identity.title.trim() ? identity.title : "untitled" : sourceTitle;
  const authors = selectMediaAuthors(identity ? identity.contributors ?? [] : source?.contributors ?? [])
    .filter(credit => creditName(credit) !== null);
  const distinctSource = identity !== null && source !== null && source.ref !== item.ref;
  const sourceAuthors = selectMediaAuthors(distinctSource ? source.contributors ?? [] : [])
    .filter(credit => creditName(credit) !== null);
  // With neither identity nor source the title is the noun itself, so it takes no prefix.
  const glyph = type ? <span className={styles.glyph}>
    <ResourceTypeIcon type={type} />
    {identity === null && source === null ? null : <span className="sr-only">{resourceTypeName(type)}: </span>}
  </span> : null;
  const role = body.kind === "prose" && body.role?.trim() ? body.role : null;

  return <figure className={styles.quotation}>
    {identity === null ? body.kind === "passage"
      ? <blockquote className={styles.body}><ResourceBody body={body} full /></blockquote>
      : <div className={styles.body}><ResourceBody body={body} full /></div> : null}
    <figcaption className={styles.attribution}>
      <div className={styles.identity}>
        {!distinctSource ? glyph : null}
        <span className={styles.identityText}>
          <ResourceLink item={item} label={title} />
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
