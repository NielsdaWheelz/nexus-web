import { createRef, type CSSProperties, type MouseEvent } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import type { ReaderScrollPositioner } from "@/lib/reader/paneScroll";
import TextDocumentReader from "./TextDocumentReader";
import styles from "./page.module.css";

const scrollPositioner: ReaderScrollPositioner = {
  async run(operation) {
    await operation({
      setTop(scrollport, top) {
        scrollport.scrollTop = Math.max(0, top);
      },
      adjustTop(scrollport, delta) {
        scrollport.scrollTop = Math.max(0, scrollport.scrollTop + delta);
      },
      reveal() {},
    });
  },
};

function renderReader(
  overrides: Partial<Parameters<typeof TextDocumentReader>[0]> = {},
) {
  const onContentClick = vi.fn();
  const onViewportReady = vi.fn();
  const onViewportScroll = vi.fn();
  const onTrustedScrollIntent = vi.fn();
  const onContentPointerOver = vi.fn();
  const onContentPointerOut = vi.fn();
  const onContentFocus = vi.fn();
  const onContentBlur = vi.fn();
  const props: Parameters<typeof TextDocumentReader>[0] = {
    mediaId: "media-1",
    mobileChromeSourceKey: "media-1",
    mobileChromeEnabled: true,
    scrollPositioner,
    readerRootRef: createRef<HTMLDivElement>(),
    contentRef: createRef<HTMLDivElement>(),
    textViewportRef: createRef<HTMLDivElement>(),
    textEndRef: createRef<HTMLElement>(),
    readerSurfaceClassName: styles.readerContentRoot,
    readerSurfaceStyle: {
      "--reader-column-width-ch": "36ch",
      "--reader-font-family": "Arial, sans-serif",
      "--reader-font-size-px": "16px",
      "--reader-line-height": "1.5",
    } as CSSProperties,
    focusMode: "off",
    hyphenation: "manual",
    contentState: {
      status: "ready",
      renderedHtml: '<p><a href="chapter-2.xhtml#target">Internal</a></p>',
    },
    onViewportReady,
    onViewportScroll,
    onTrustedScrollIntent,
    endContent: <p>End of article</p>,
    onContentClick,
    onContentPointerOver,
    onContentPointerOut,
    onContentFocus,
    onContentBlur,
    ...overrides,
  };

  const view = render(<TextDocumentReader {...props} />, {
    wrapper: MobileChromeProvider,
  });
  return {
    props,
    rerender: view.rerender,
    onContentClick,
    onViewportReady,
    onViewportScroll,
    onTrustedScrollIntent,
    onContentPointerOver,
    onContentPointerOut,
    onContentFocus,
    onContentBlur,
  };
}

describe("TextDocumentReader", () => {
  it("renders reader banners and its in-flow endcap inside the accessible reading area", () => {
    renderReader({
      beforeContent: <div>Reader readiness</div>,
      contentState: {
        status: "ready",
        renderedHtml: '<h1 id="chapter-one">Chapter one</h1>',
      },
    });

    const viewport = screen.getByRole("region", {
      name: "Document reading area",
    });
    expect(viewport).toHaveAttribute("tabindex", "0");
    expect(viewport).toContainElement(screen.getByText("Reader readiness"));
    expect(viewport).toContainElement(screen.getByText("End of article"));
    expect(
      screen.queryByRole("heading", { level: 1, name: "Chapter one" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Chapter one" }),
    ).toHaveAttribute("id", "chapter-one");
  });

  it("routes resolved internal links without invoking the highlight click path", () => {
    const onInternalLinkClick = vi.fn(() => true);
    const { onContentClick } = renderReader({ onInternalLinkClick });

    fireEvent.click(screen.getByRole("link", { name: "Internal" }));

    expect(onInternalLinkClick).toHaveBeenCalledWith("chapter-2.xhtml#target");
    expect(onContentClick).not.toHaveBeenCalled();
  });

  it("falls through to the highlight click path for unresolved links", () => {
    const onInternalLinkClick = vi.fn(() => false);
    const onContentClick = vi.fn((event: MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
    });
    renderReader({ onInternalLinkClick, onContentClick });

    fireEvent.click(screen.getByRole("link", { name: "Internal" }));

    expect(onInternalLinkClick).toHaveBeenCalledWith("chapter-2.xhtml#target");
    expect(onContentClick).toHaveBeenCalledTimes(1);
  });

  it("forwards prose pointer hover to onContentPointerOver", () => {
    const { onContentPointerOver } = renderReader({
      contentState: {
        status: "ready",
        renderedHtml:
          '<span data-active-highlight-ids="h1" data-highlight-top="h1">marked</span>',
      },
    });

    fireEvent.pointerOver(screen.getByText("marked"));

    expect(onContentPointerOver).toHaveBeenCalledTimes(1);
  });

  it("delegates non-anchor apparatus elements to content handlers", () => {
    const {
      onContentClick,
      onContentPointerOver,
      onContentPointerOut,
      onContentFocus,
      onContentBlur,
    } = renderReader({
      contentState: {
        status: "ready",
        renderedHtml:
          '<span tabindex="0" data-reader-apparatus-item-id="margin-1">Margin note</span>',
      },
    });

    const marginNote = screen.getByText("Margin note");
    fireEvent.click(marginNote);
    fireEvent.pointerOver(marginNote);
    fireEvent.pointerOut(marginNote);
    fireEvent.focus(marginNote);
    fireEvent.blur(marginNote);

    expect(onContentClick).toHaveBeenCalledTimes(1);
    expect(onContentPointerOver).toHaveBeenCalledTimes(1);
    expect(onContentPointerOut).toHaveBeenCalledTimes(1);
    expect(onContentFocus).toHaveBeenCalledTimes(1);
    expect(onContentBlur).toHaveBeenCalledTimes(1);
  });

  it("marks rendered annotations as handled before their click reaches reader chrome", () => {
    renderReader({
      contentState: {
        status: "ready",
        renderedHtml:
          '<p><span data-active-highlight-ids="h1">Highlight</span> <span data-reader-apparatus-item-id="margin-1">Margin note</span></p>',
      },
    });

    const highlight = screen.getByText("Highlight");
    const apparatus = screen.getByText("Margin note");
    fireEvent.click(highlight);
    fireEvent.click(apparatus);

    expect(highlight).toHaveAttribute("data-reader-tap-handled", "true");
    expect(apparatus).toHaveAttribute("data-reader-tap-handled", "true");
  });

  it("publishes one reader-owned snapshot from its exact viewport", () => {
    const { props, rerender, onViewportReady, onViewportScroll } = renderReader();
    const viewport = screen.getByTestId("document-viewport");
    Object.defineProperties(viewport, {
      scrollTop: { value: 120, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
      clientHeight: { value: 400, configurable: true },
    });

    expect(props.textViewportRef.current).toBe(viewport);
    expect(onViewportReady).toHaveBeenCalledTimes(1);

    fireEvent.scroll(window);
    expect(onViewportScroll).not.toHaveBeenCalled();

    fireEvent.scroll(viewport);
    expect(onViewportScroll).toHaveBeenCalledWith({
      scrollTop: 120,
      scrollHeight: 1_000,
      clientHeight: 400,
    });

    rerender(<TextDocumentReader {...props} mediaId="media-2" />);
    expect(onViewportReady).toHaveBeenCalledTimes(2);
  });

  it("publishes trusted forward and backward intent even when a short document cannot scroll", async () => {
    const { onTrustedScrollIntent } = renderReader();
    const viewport = screen.getByTestId("document-viewport");
    const user = userEvent.setup();

    await user.click(viewport);
    await user.wheel(viewport, { delta: { y: 1 } });
    await user.keyboard("{End}");
    await user.wheel(viewport, { delta: { y: -1 } });
    await user.keyboard("{ArrowUp}");

    expect(onTrustedScrollIntent).toHaveBeenNthCalledWith(1, "forward");
    expect(onTrustedScrollIntent).toHaveBeenNthCalledWith(2, "forward");
    expect(onTrustedScrollIntent).toHaveBeenNthCalledWith(3, "backward");
    expect(onTrustedScrollIntent).toHaveBeenNthCalledWith(4, "backward");
  });

  it("does not publish intent from scripted wheel or keyboard events", () => {
    const { onTrustedScrollIntent } = renderReader();
    const viewport = screen.getByTestId("document-viewport");

    fireEvent.wheel(viewport, { deltaY: 1 });
    fireEvent.keyDown(viewport, { key: "End" });

    expect(onTrustedScrollIntent).not.toHaveBeenCalled();
  });

  it("does not arm pointer scrolling from document content", () => {
    const { onTrustedScrollIntent } = renderReader();
    const viewport = screen.getByTestId("document-viewport");
    Object.defineProperties(viewport, {
      scrollTop: { value: 40, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
      clientHeight: { value: 400, configurable: true },
    });

    fireEvent.pointerDown(screen.getByRole("link", { name: "Internal" }));
    fireEvent.scroll(viewport);

    expect(onTrustedScrollIntent).not.toHaveBeenCalled();
  });
});
