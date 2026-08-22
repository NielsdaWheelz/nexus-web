import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import { applyHighlightsToHtml } from "@/lib/highlights/applySegments";
import type { ReaderScrollPositioner } from "@/lib/reader/paneScroll";
import TextDocumentReader, {
  type TextReaderContentDecorator,
} from "./TextDocumentReader";

const CANONICAL_HTML = "<p>Alpha beacon omega</p>";
const CANONICAL_TEXT = "Alpha beacon omega";

const noopPositioner: ReaderScrollPositioner = {
  async run(operation) {
    await operation({
      setTop: () => undefined,
      adjustTop: () => undefined,
      reveal: () => undefined,
    });
  },
};

function renderLeaf(
  props: Partial<Parameters<typeof TextDocumentReader>[0]> = {},
) {
  return render(
    <TextDocumentReader
      mediaId="11111111-1111-4111-8111-111111111111"
      scrollPositioner={noopPositioner}
      readerRootRef={createRef<HTMLDivElement>()}
      contentRef={createRef<HTMLDivElement>()}
      textViewportRef={createRef<HTMLDivElement>()}
      textEndRef={createRef<HTMLElement>()}
      readerThemeClassName=""
      readerSurfaceStyle={{}}
      focusMode="off"
      hyphenation="auto"
      contentState={{ status: "ready", renderedHtml: CANONICAL_HTML }}
      onViewportReady={() => undefined}
      onViewportScroll={() => undefined}
      onTrustedScrollIntent={() => undefined}
      endContent={null}
      onContentClick={() => undefined}
      onContentPointerOver={() => undefined}
      onContentPointerOut={() => undefined}
      onContentFocus={() => undefined}
      onContentBlur={() => undefined}
      {...props}
    />,
  );
}

describe("TextDocumentReader canonical content and hosted decoration port", () => {
  it("renders undecorated canonical HTML when no decorator is supplied (the offline default)", async () => {
    renderLeaf();

    const paragraph = await screen.findByText(CANONICAL_TEXT);
    expect(paragraph).toBeVisible();
    // No decoration may be baked in: the canonical text renders as one
    // untouched text node with no highlight wrappers anywhere in the content.
    // (HtmlRenderer's own `data-paragraph` focus instrumentation is leaf
    // presentation, not decoration.)
    expect(paragraph.childNodes).toHaveLength(1);
    expect(paragraph.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE);
    expect(
      // eslint-disable-next-line testing-library/no-node-access -- highlight wrappers carry no accessible role; raw markup is the contract
      document.querySelectorAll("[data-active-highlight-ids]"),
    ).toHaveLength(0);
  });

  it("applies hosted highlight decoration through the decorator port after load", async () => {
    const decorator: TextReaderContentDecorator = {
      decorate: (canonicalHtml) =>
        applyHighlightsToHtml(canonicalHtml, CANONICAL_TEXT, "fragment-1", [
          {
            id: "highlight-1",
            start_offset: CANONICAL_TEXT.indexOf("beacon"),
            end_offset: CANONICAL_TEXT.indexOf("beacon") + "beacon".length,
            color: "yellow",
            created_at: "2026-08-01T12:00:00.000Z",
          },
        ]).html,
    };
    renderLeaf({ decorator });

    const mark = await screen.findByText("beacon");
    // eslint-disable-next-line testing-library/no-node-access -- decoration wrappers carry no accessible role; the anchor attribute is the contract
    const wrapper = mark.closest("[data-active-highlight-ids]");
    expect(
      wrapper,
      "hosted decoration did not reach the rendered content",
    ).not.toBeNull();
    expect(wrapper?.getAttribute("data-active-highlight-ids")).toBe(
      "highlight-1",
    );
  });

  it("offers the supplied retry action on a document error state", async () => {
    const retry = vi.fn();
    renderLeaf({
      contentState: {
        status: "error",
        message: "Media couldn’t be loaded",
        retry,
      },
    });

    expect(await screen.findByText("Media couldn’t be loaded")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
