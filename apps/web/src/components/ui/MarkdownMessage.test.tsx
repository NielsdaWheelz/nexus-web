import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import type { ReaderCitationData } from "@/lib/conversations/readerCitation";

function findRange(content: string, exact: string) {
  const start = content.indexOf(exact);
  if (start < 0) throw new Error(`Missing test range: ${exact}`);
  return {
    start,
    end: start + exact.length,
    blockIndex: 0,
    locatorStart: start,
    locatorEnd: start + exact.length,
  };
}

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

describe("MarkdownMessage Find projection", () => {
  it("marks exact visible text inside Markdown formatting", () => {
    const content = "Before **needle** after";
    render(
      <MarkdownMessage
        content={content}
        findRange={findRange(content, "needle")}
      />,
    );

    const mark = screen.getByLabelText("Current match");
    expect(mark).toHaveTextContent("needle");
    expect(mark).toHaveAttribute(
      "data-find-start",
      String(content.indexOf("needle")),
    );
  });

  it("does not fabricate a mark for invisible Markdown link syntax", () => {
    const content = "[Visible label](https://hidden.example/path)";
    render(
      <MarkdownMessage
        content={content}
        findRange={findRange(content, "hidden.example")}
      />,
    );

    expect(screen.queryByLabelText("Current match")).toBeNull();
    expect(screen.getByRole("link", { name: "Visible label" })).toBeVisible();
  });

  it("keeps the exact source locator after citation substitution shifts rendered offsets", () => {
    const content = "Evidence [1] then needle";
    render(
      <FeedbackProvider>
        <MarkdownMessage
          content={content}
          citations={[citation]}
          findRange={findRange(content, "needle")}
        />
      </FeedbackProvider>,
    );

    const mark = screen.getByLabelText("Current match");
    expect(mark).toHaveTextContent("needle");
    expect(mark).toHaveAttribute(
      "data-find-start",
      String(content.indexOf("needle")),
    );
  });
});
