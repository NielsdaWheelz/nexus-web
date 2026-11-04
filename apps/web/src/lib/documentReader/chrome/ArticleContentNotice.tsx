// The saved representation's limits. This copy never enters authored text or quote offsets.
import type { Schema } from "@/lib/api/wire";
import styles from "./chrome.module.css";

export function articleContentLabel(content: Schema<"XArticleContent">): string {
  if (content.completeness === "incomplete") return "incomplete text";
  return content.representation === "api_text" ? "api text" : "browser copy";
}

export function ArticleContentNotice({ content }: { readonly content: Schema<"XArticleContent"> }) {
  const line = content.representation === "browser_capture" ? "captured from your browser. it may be incomplete."
    : content.completeness === "incomplete" ? "x reports this text is incomplete. formatting and media aren’t kept."
      : "text from x’s api. formatting and media aren’t kept.";
  return <p className={styles.articleContent}>{line}</p>;
}
