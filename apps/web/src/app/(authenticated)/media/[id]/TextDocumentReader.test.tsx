import { createRef, type CSSProperties, type MouseEvent } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TextDocumentReader from "./TextDocumentReader";
import styles from "./page.module.css";

function renderReader(
  overrides: Partial<Parameters<typeof TextDocumentReader>[0]> = {},
) {
  const onContentClick = vi.fn();
  const onDocumentScroll = vi.fn();
  const onContentPointerOver = vi.fn();
  const onContentPointerOut = vi.fn();
  const onContentFocus = vi.fn();
  const onContentBlur = vi.fn();
  const props: Parameters<typeof TextDocumentReader>[0] = {
    mediaId: "media-1",
    readerRootRef: createRef<HTMLDivElement>(),
    contentRef: createRef<HTMLDivElement>(),
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
    onDocumentScroll,
    onContentClick,
    onContentPointerOver,
    onContentPointerOut,
    onContentFocus,
    onContentBlur,
    ...overrides,
  };

  render(<TextDocumentReader {...props} />);
  return {
    onContentClick,
    onDocumentScroll,
    onContentPointerOver,
    onContentPointerOut,
    onContentFocus,
    onContentBlur,
  };
}

describe("TextDocumentReader", () => {
  it("routes resolved internal links without invoking the highlight click path", () => {
    const onInternalLinkClick = vi.fn(() => true);
    const { onContentClick } = renderReader({
      onInternalLinkClick,
    });

    fireEvent.click(screen.getByRole("link", { name: "Internal" }));

    expect(onInternalLinkClick).toHaveBeenCalledWith("chapter-2.xhtml#target");
    expect(onContentClick).not.toHaveBeenCalled();
  });

  it("falls through to the highlight click path for unresolved links", () => {
    const onInternalLinkClick = vi.fn(() => false);
    const onContentClick = vi.fn((event: MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
    });
    renderReader({
      onInternalLinkClick,
      onContentClick,
    });

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

  it("publishes document viewport scroll snapshots", () => {
    const { onDocumentScroll } = renderReader();
    const viewport = screen.getByTestId("document-viewport");
    Object.defineProperties(viewport, {
      scrollTop: { value: 120, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
      clientHeight: { value: 400, configurable: true },
    });

    fireEvent.scroll(viewport);

    expect(onDocumentScroll).toHaveBeenCalledWith({
      scrollTop: 120,
      scrollHeight: 1_000,
      clientHeight: 400,
    });
  });

  it("centers the fixed-measure text column inside a wider reader viewport", () => {
    render(
      <div style={{ width: "900px", height: "500px", display: "flex" }}>
        <TextDocumentReader
          mediaId="media-1"
          readerRootRef={createRef<HTMLDivElement>()}
          contentRef={createRef<HTMLDivElement>()}
          readerSurfaceClassName={styles.readerContentRoot}
          readerSurfaceStyle={
            {
              "--reader-column-width-ch": "36ch",
              "--reader-font-family": "Arial, sans-serif",
              "--reader-font-size-px": "16px",
              "--reader-line-height": "1.5",
            } as CSSProperties
          }
          focusMode="off"
          hyphenation="manual"
          contentState={{
            status: "ready",
            renderedHtml: "<p>Centered text.</p>",
          }}
          onDocumentScroll={() => {}}
          onContentClick={() => {}}
          onContentPointerOver={() => {}}
          onContentPointerOut={() => {}}
          onContentFocus={() => {}}
          onContentBlur={() => {}}
        />
      </div>,
    );

    const viewport = screen.getByTestId("document-viewport");
    const content = screen.getByTestId("html-renderer");
    const viewportRect = viewport.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();

    expect(
      Math.abs(
        (contentRect.left + contentRect.right) / 2 -
          (viewportRect.left + viewportRect.right) / 2,
      ),
    ).toBeLessThan(1);
    expect(contentRect.width).toBeLessThan(viewportRect.width);
  });
});
