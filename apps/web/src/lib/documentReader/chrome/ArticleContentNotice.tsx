// The saved representation's limits. This copy never enters authored text or quote offsets.
import { FeedbackNotice } from "@/components/feedback/Feedback";
import type { Schema } from "@/lib/api/wire";

export function articleContentLabel(content: Schema<"XArticleContent">): string {
  if (content.completeness === "incomplete") return "incomplete text";
  return content.representation === "api_text" ? "api text" : "browser copy";
}

export function ArticleContentNotice({ content }: { readonly content: Schema<"XArticleContent"> }) {
  const message = content.representation === "browser_capture"
    ? "captured from the open article; completeness is unverified."
    : content.completeness === "incomplete"
      ? "x reports that this text is incomplete. original formatting and media aren’t preserved."
      : "text supplied by x’s api. original formatting and media aren’t preserved; completeness is unverified.";
  return <FeedbackNotice content={{ tone: "Neutral", title: `${articleContentLabel(content)} · ${message}` }} announcement="None" />;
}
