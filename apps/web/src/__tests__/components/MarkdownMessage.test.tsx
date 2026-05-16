import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);

afterEach(() => {
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
    return;
  }

  Reflect.deleteProperty(navigator, "clipboard");
});

describe("MarkdownMessage", () => {
  it("renders unlabeled fenced code as a copyable code block", () => {
    render(
      <MarkdownMessage
        content={["```", "const plain = true;", "```"].join("\n")}
      />,
    );

    expect(screen.getByRole("button", { name: "copy" })).toBeInTheDocument();
    expect(screen.getByText("text")).toBeInTheDocument();
    expect(screen.getByText("const plain = true;")).toBeInTheDocument();
  });

  it("copies the clicked code block when languages repeat", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn((_text: string) => Promise.resolve());

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <MarkdownMessage
        content={[
          "```ts",
          "const selected = 'first';",
          "```",
          "",
          "```ts",
          "const selected = 'second';",
          "```",
        ].join("\n")}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: "copy" })[1]);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });

    const copiedText = writeText.mock.calls[0]?.[0];
    expect(copiedText).toContain("second");
    expect(copiedText).not.toContain("first");
  });

  it("wraps markdown tables in a horizontal scroll container", () => {
    render(
      <MarkdownMessage
        content={[
          "| Column A | Column B |",
          "| --- | --- |",
          "| Alpha | Beta |",
        ].join("\n")}
      />,
    );

    const table = screen.getByRole("table");
    expect(screen.getByTestId("markdown-table-scroll")).toContainElement(table);
  });

  it("keeps markdown structure when inserting citation controls", () => {
    const content = [
      "- First claim.",
      "- Second claim.",
      "",
      "```ts",
      "const preserved = true;",
      "```",
      "",
      "| Source | Claim |",
      "| --- | --- |",
      "| Paper | Table claim |",
    ].join("\n");
    const target = {
      source: "claim_evidence" as const,
      media_id: "media-1",
      locator: {
        type: "pdf_page_geometry" as const,
        media_id: "media-1",
        page_number: 4,
        quads: [{ x1: 1 }],
        exact: "Second claim.",
      },
      snippet: "Second claim.",
      source_version: "pdf-source:v1",
      highlight_behavior: "pulse" as const,
      focus_behavior: "scroll_into_view" as const,
      status: "resolved",
    };
    const citationEnd =
      content.indexOf("Second claim.") + "Second claim.".length;

    render(
      <MarkdownMessage
        content={content}
        citationRanges={[
          {
            start: content.indexOf("Second claim."),
            end: citationEnd,
            citation: {
              index: 1,
              color: "neutral",
              target,
              href: null,
              preview: { title: "Research PDF" },
            },
          },
        ]}
        onCitationActivate={vi.fn()}
      />,
    );

    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(
      screen.getByText((_, element) =>
        Boolean(
          element?.tagName.toLowerCase() === "code" &&
          element.textContent
            ?.replace(/\s+/g, " ")
            .includes("const preserved = true;"),
        ),
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open citation 1" }),
    ).toBeInTheDocument();
  });

  it("runs inline citation hover actions from supplied persisted data", async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    const onCitationActivate = vi.fn();
    const onAskAboutSource = vi.fn();
    const onSaveSourceQuote = vi.fn();
    const target = {
      source: "claim_evidence" as const,
      media_id: "media-1",
      locator: {
        type: "pdf_page_geometry" as const,
        media_id: "media-1",
        page_number: 4,
        quads: [{ x1: 1 }],
        exact: "PDF quote",
      },
      snippet: "PDF quote",
      source_version: "pdf-source:v1",
      highlight_behavior: "pulse" as const,
      focus_behavior: "scroll_into_view" as const,
      status: "resolved",
    };

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <MarkdownMessage
        content="A supported sentence."
        citationRanges={[
          {
            start: 0,
            end: "A supported sentence.".length,
            citation: {
              index: 1,
              color: "neutral",
              target,
              href: null,
              preview: {
                title: "Research PDF",
                excerpt: "PDF quote",
                meta: ["Page 4", "pdf-source:v1"],
                copyText: "Research PDF\nPDF quote\nPage 4",
                saveable: true,
              },
            },
          },
        ]}
        onCitationActivate={onCitationActivate}
        onAskAboutSource={onAskAboutSource}
        onSaveSourceQuote={onSaveSourceQuote}
      />,
    );

    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "Open citation 1" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    await userEvent.click(
      screen.getByRole("button", { name: "Open in context" }),
    );
    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "Open citation 1" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await userEvent.click(
      screen.getByRole("button", { name: "Ask about this" }),
    );
    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "Open citation 1" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await userEvent.click(screen.getByRole("button", { name: "Save quote" }));
    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "Open citation 1" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await userEvent.click(
      screen.getByRole("button", { name: "Copy citation" }),
    );

    expect(onCitationActivate).toHaveBeenCalledWith(target);
    expect(onAskAboutSource).toHaveBeenCalledWith(target);
    expect(onSaveSourceQuote).toHaveBeenCalledWith(target);
    expect(writeText).toHaveBeenCalledWith("Research PDF\nPDF quote\nPage 4");
  });
});
