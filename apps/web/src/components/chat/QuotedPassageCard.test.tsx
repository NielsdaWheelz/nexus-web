import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MediaRetrievalLocator } from "@/lib/api/sse/locators";
import type { PendingTurnContext } from "@/lib/conversations/pendingTurnContext";
import type {
  ReaderSelectionOut,
  ReaderSelectionPreview,
} from "@/lib/conversations/readerSelection";
import { assumeReaderSelectionKey } from "@/lib/conversations/readerSelectionKey";
import type { ReaderHighlightChatIntent } from "@/lib/conversations/readerHighlightChatIntent";
import type { ResourceActivation } from "@/lib/resources/activation";
import QuotedPassageCard from "./QuotedPassageCard";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const HIGHLIGHT_ID = "22222222-2222-4222-8222-222222222222";
const KEY = assumeReaderSelectionKey({ mediaId: MEDIA_ID, highlightId: HIGHLIGHT_ID });

const SOURCE_LABEL = "Chapter 3 — The Tempest";

// Long enough to overflow the four-line clamp inside the narrow test frame, so
// the disclosure control is exercised deterministically.
const LONG_EXACT =
  "The barometer had been falling since dawn, and by the afternoon watch the " +
  "whole horizon to the south-west had gone the colour of a bruise. Every hand " +
  "aboard knew what that meant, and the older sailors said little, which was " +
  "always the worst sign of all. We shortened sail and waited for the sea to " +
  "make up its mind about us.";

const LOCATOR: MediaRetrievalLocator = {
  type: "web_text_offsets",
  media_id: MEDIA_ID,
  fragment_id: "frag-1",
  start_offset: 0,
  end_offset: LONG_EXACT.length,
};

const ROUTE_ACTIVATION: ResourceActivation = {
  resourceRef: `media:${MEDIA_ID}`,
  kind: "route",
  href: `/media/${MEDIA_ID}`,
  unresolvedReason: null,
};

const NONE_ACTIVATION: ResourceActivation = {
  resourceRef: `media:${MEDIA_ID}`,
  kind: "none",
  href: null,
  unresolvedReason: "missing",
};

const INTENT: ReaderHighlightChatIntent = {
  destination: { kind: "New" },
  selection: KEY,
};

function selection(overrides: Partial<ReaderSelectionOut> = {}): ReaderSelectionOut {
  return {
    key: KEY,
    sourceLabel: SOURCE_LABEL,
    exact: LONG_EXACT,
    prefix: "As the storm gathered, ",
    suffix: " and the ship groaned at her seams.",
    locator: LOCATOR,
    activation: ROUTE_ACTIVATION,
    ...overrides,
  };
}

function preview(overrides: Partial<ReaderSelectionOut> = {}): ReaderSelectionPreview {
  return { ...selection(overrides), revision: "a".repeat(64) };
}

// A fixed narrow frame so the clamp measurement is deterministic in real Chromium.
function renderFramed(node: ReactElement) {
  return render(<div style={{ width: "320px" }}>{node}</div>);
}

describe("QuotedPassageCard", () => {
  it("names itself and shows the exact stored text in a blockquote (sent)", () => {
    renderFramed(
      <QuotedPassageCard mode="sent" selection={selection()} onActivateSource={vi.fn()} />,
    );

    expect(screen.getByRole("figure", { name: "Quoted passage" })).toBeInTheDocument();
    // HighlightSnippet emphasises `exact` in its own <mark>, so the whole passage
    // is present verbatim in the DOM.
    expect(screen.getByText(LONG_EXACT)).toBeInTheDocument();
  });

  it("clamps to four lines but keeps the full text; Expand reveals it", async () => {
    const user = userEvent.setup();
    renderFramed(
      <QuotedPassageCard mode="sent" selection={selection()} onActivateSource={vi.fn()} />,
    );

    const expand = await screen.findByRole("button", { name: "Expand quoted passage" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    // Full text is in the DOM even while visually clamped.
    expect(screen.getByText(LONG_EXACT)).toBeInTheDocument();

    await user.click(expand);

    const collapse = screen.getByRole("button", { name: "Collapse quoted passage" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(LONG_EXACT)).toBeInTheDocument();
  });

  it("shows no disclosure when the passage fits in four lines", async () => {
    renderFramed(
      <QuotedPassageCard
        mode="sent"
        selection={selection({ exact: "A short line.", prefix: "", suffix: "" })}
        onActivateSource={vi.fn()}
      />,
    );

    // The blockquote is present with the full text; the clamp never engages, so
    // no disclosure is offered.
    expect(await screen.findByText("A short line.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Expand quoted passage" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Collapse quoted passage" })).toBeNull();
  });

  it("fires onActivateSource from the source button when the source is a route", async () => {
    const user = userEvent.setup();
    const onActivateSource = vi.fn();
    renderFramed(
      <QuotedPassageCard
        mode="sent"
        selection={selection()}
        onActivateSource={onActivateSource}
      />,
    );

    const source = screen.getByRole("button", { name: `Open source: ${SOURCE_LABEL}` });
    await user.click(source);
    expect(onActivateSource).toHaveBeenCalledTimes(1);
    expect(onActivateSource).toHaveBeenCalledWith(expect.objectContaining({ key: KEY }));
  });

  it("renders plain unavailable text and no control when activation is none", () => {
    const onActivateSource = vi.fn();
    renderFramed(
      <QuotedPassageCard
        mode="sent"
        selection={selection({ activation: NONE_ACTIVATION })}
        onActivateSource={onActivateSource}
      />,
    );

    expect(screen.getByText("Source unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open source/ })).toBeNull();
    // The label survives as plain text.
    expect(screen.getByText(SOURCE_LABEL)).toBeInTheDocument();
  });

  it("has no Remove control in sent mode", () => {
    renderFramed(
      <QuotedPassageCard mode="sent" selection={selection()} onActivateSource={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Remove quoted passage" })).toBeNull();
  });

  it("fires onRemove from the pending card", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const context: PendingTurnContext = { kind: "ReaderHighlight", preview: preview() };
    renderFramed(
      <QuotedPassageCard
        mode="pending"
        context={context}
        onRemove={onRemove}
        onRetry={vi.fn()}
        onActivateSource={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Remove quoted passage" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("renders a blocking loading affordance that can still be removed", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const context: PendingTurnContext = { kind: "Loading", intent: INTENT };
    renderFramed(
      <QuotedPassageCard
        mode="pending"
        context={context}
        onRemove={onRemove}
        onRetry={vi.fn()}
        onActivateSource={vi.fn()}
      />,
    );

    expect(screen.getByText("Loading quoted passage…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove quoted passage" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("renders the error and a Retry control on load failure", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const context: PendingTurnContext = {
      kind: "LoadFailed",
      intent: INTENT,
      error: {
        severity: "error",
        title: "Couldn't load the quoted passage",
        message: "The reader service didn't respond.",
      },
    };
    renderFramed(
      <QuotedPassageCard
        mode="pending"
        context={context}
        onRemove={vi.fn()}
        onRetry={onRetry}
        onActivateSource={vi.fn()}
      />,
    );

    expect(screen.getByText("Couldn't load the quoted passage")).toBeInTheDocument();
    expect(screen.getByText("The reader service didn't respond.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry loading quoted passage" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Forbidden", "You can't quote this passage"],
    ["GeometryOnly", "Nothing to quote here"],
    ["TooLarge", "This passage is too long to quote"],
  ] as const)(
    "renders an authoritative non-sendable message for %s (no Retry)",
    (reason, title) => {
      const context: PendingTurnContext = { kind: "NonSendable", intent: INTENT, reason };
      renderFramed(
        <QuotedPassageCard
          mode="pending"
          context={context}
          onRemove={vi.fn()}
          onRetry={vi.fn()}
          onActivateSource={vi.fn()}
        />,
      );

      expect(screen.getByText(title)).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Retry loading quoted passage" }),
      ).toBeNull();
      // Still removable so the user is never trapped.
      expect(
        screen.getByRole("button", { name: "Remove quoted passage" }),
      ).toBeInTheDocument();
    },
  );

  it("exposes a polite status region", () => {
    const context: PendingTurnContext = { kind: "Loading", intent: INTENT };
    renderFramed(
      <QuotedPassageCard
        mode="pending"
        context={context}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
        onActivateSource={vi.fn()}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Loading the quoted passage.");
  });
});
