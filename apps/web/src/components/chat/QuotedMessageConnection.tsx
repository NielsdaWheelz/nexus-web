import ResourceLink from "@/components/resources/ResourceLink";
import ResourceQuotation from "@/components/resources/ResourceQuotation";
import type { Schema } from "@/lib/api/wire";
import styles from "./QuotedMessageConnection.module.css";

/** One question and its frozen source; the reader host owns the row and focus. */
export default function QuotedMessageConnection({ content }: {
  readonly content: Schema<"ReaderEvidenceQuotationOut">;
}) {
  return <div className={styles.connection}>
    <div className={styles.question}><ResourceLink item={content.item} /></div>
    <ResourceQuotation item={content.quotation} />
  </div>;
}
