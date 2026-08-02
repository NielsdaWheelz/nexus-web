import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component, type ReactNode } from "react";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { MarkdownMessage } from "@/components/ui/MarkdownMessage";
import type { ReaderCitationData } from "@/lib/conversations/readerCitation";
import { ClipboardWriteUnavailableError } from "@/lib/ui/copyText";

const copyText = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ui/copyText", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ui/copyText")>(
    "@/lib/ui/copyText",
  );
  return {
    ...actual,
    copyText: (...args: unknown[]) => copyText(...args),
  };
});

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

class MarkdownDefectBoundary extends Component<
  { children: ReactNode; onDefect: (error: unknown) => void },
  { error: unknown | null }
> {
  state: { error: unknown | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    this.props.onDefect(error);
  }

  render() {
    return this.state.error === null ? (
      this.props.children
    ) : (
      <p>Markdown defect boundary</p>
    );
  }
}

describe("MarkdownMessage", () => {
  afterEach(() => {
    copyText.mockReset();
    vi.restoreAllMocks();
  });

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

  it("keeps finite clipboard unavailability as exact code-copy failure", async () => {
    copyText.mockRejectedValue(new ClipboardWriteUnavailableError());
    const user = userEvent.setup();
    render(<MarkdownMessage content={"```ts\nconst value = 1;\n```"} />);

    await user.click(screen.getByRole("button", { name: "copy" }));

    expect(
      await screen.findByRole("button", { name: "copy failed" }),
    ).toBeInTheDocument();
  });

  it("routes unknown code-copy rejection through the render boundary", async () => {
    const defect = new TypeError("unexpected clipboard defect");
    copyText.mockRejectedValue(defect);
    const onDefect = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    render(
      <MarkdownDefectBoundary onDefect={onDefect}>
        <MarkdownMessage content={"```ts\nconst value = 1;\n```"} />
      </MarkdownDefectBoundary>,
    );

    await user.click(screen.getByRole("button", { name: "copy" }));

    expect(await screen.findByText("Markdown defect boundary")).toBeVisible();
    expect(onDefect).toHaveBeenCalledWith(defect);
  });
});
