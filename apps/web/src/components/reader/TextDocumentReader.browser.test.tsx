import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { useReaderScrollPositioner } from "@/lib/reader/paneScroll";
import TextDocumentReader from "./TextDocumentReader";

const CANONICAL_HTML = "<p>Alpha beacon omega</p>";
const CANONICAL_TEXT = "Alpha beacon omega";

function renderLeaf(
  props: Partial<Parameters<typeof TextDocumentReader>[0]> = {},
) {
  return render(<MobileChromeProvider><LeafHarness {...props} /></MobileChromeProvider>);
}

function LeafHarness(props: Partial<Parameters<typeof TextDocumentReader>[0]>) {
  const positioner = useReaderScrollPositioner();
  return (
    <TextDocumentReader
      mediaId="11111111-1111-4111-8111-111111111111"
      scrollPositioner={positioner}
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
    />
  );
}

describe("TextDocumentReader canonical content", () => {
  it("renders the canonical HTML it is given, decorating nothing", async () => {
    renderLeaf();

    const paragraph = await screen.findByText(CANONICAL_TEXT);
    expect(paragraph).toBeVisible();
    // The leaf decorates nothing: the canonical text renders as one untouched
    // text node with no highlight wrappers anywhere in the content.
    // (HtmlRenderer's own `data-paragraph` focus instrumentation is leaf
    // presentation, not decoration.)
    expect(paragraph.childNodes).toHaveLength(1);
    expect(paragraph.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE);
    expect(
      // eslint-disable-next-line testing-library/no-node-access -- highlight wrappers carry no accessible role; raw markup is the contract
      document.querySelectorAll("[data-active-highlight-ids]"),
    ).toHaveLength(0);
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

it("keeps independent admitted units and their cross-unit selection intact through reader chrome updates", async () => {
  const first = document.createElement("div");
  const firstParagraph = document.createElement("p");
  const firstText = document.createTextNode("first admitted unit");
  firstParagraph.append(firstText); first.append(firstParagraph);
  const second = document.createElement("div");
  const secondParagraph = document.createElement("p");
  const secondText = document.createTextNode("second admitted unit");
  secondParagraph.append(secondText); second.append(secondParagraph);
  const contentState = { status: "ready" as const, preparedRoots: [{ key: "first", root: first }, { key: "second", root: second }] };
  const view = renderLeaf({ contentState });
  expect(await screen.findByText("first admitted unit")).toBe(firstParagraph);
  expect(screen.getByText("second admitted unit")).toBe(secondParagraph);
  const selection = document.getSelection();
  if (selection === null) throw new Error("Browser selection is unavailable");
  const range = document.createRange(); range.setStart(firstText, 2); range.setEnd(secondText, 6);
  selection.removeAllRanges(); selection.addRange(range);
  const selected = selection.toString();
  view.rerender(<MobileChromeProvider><LeafHarness contentState={contentState} focusMode="paragraph" /></MobileChromeProvider>);
  expect(selection.toString()).toBe(selected);
  expect(screen.getByText("first admitted unit")).toBe(firstParagraph);
  view.unmount();
  expect(first.isConnected).toBe(false);
  expect(second.isConnected).toBe(false);
  selection.removeAllRanges();
});
