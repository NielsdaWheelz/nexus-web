import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import type { ReaderCitationData } from "@/lib/conversations/readerCitation";

const citation: ReaderCitationData = {
  index: 1,
  preview: { title: "Source" },
  activation: {
    resourceRef: "media:11111111-1111-4111-8111-111111111111",
    kind: "route",
    href: "/media/11111111-1111-4111-8111-111111111111",
    unresolvedReason: null,
  },
  target: null,
};

describe("MarkdownMessage", () => {
  it("renders GFM labels without exposing Markdown syntax or link destinations", () => {
    render(
      <MarkdownMessage
        content={
          "**Bold label** and [Visible link](https://hidden.example/path)"
        }
      />,
    );

    expect(screen.getByText("Bold label")).toHaveProperty(
      "tagName",
      "STRONG",
    );
    expect(screen.getByRole("link", { name: "Visible link" })).toHaveAttribute(
      "href",
      "https://hidden.example/path",
    );
    expect(screen.queryByText(/\*\*/)).toBeNull();
    expect(screen.queryByText(/hidden\.example/)).toBeNull();
  });

  it("renders resolved citations as excluded controls and omits unresolved markers", () => {
    const content = "Evidence [1], missing [2], literal <<cite:3>>.";
    render(
      <FeedbackProvider>
        <MarkdownMessage
          content={content}
          citations={[citation]}
        />
      </FeedbackProvider>,
    );

    expect(
      screen.getByRole("link", { name: "Open citation 1" }),
    ).toHaveAttribute("data-pane-find-exclude", "true");
    expect(screen.queryByText("2")).toBeNull();
    expect(screen.getByText("<<cite:3>>", { exact: false })).toBeVisible();
    expect(screen.queryByText(/nexus-reader-citation/)).toBeNull();
    expect(screen.getByText(/Evidence/)).toHaveTextContent(
      "Evidence 1, missing , literal <<cite:3>>.",
    );
  });
});
