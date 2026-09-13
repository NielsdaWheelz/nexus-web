import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { cdp, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import { toTopLevelCdpCoordinate } from "@/__tests__/helpers/trustedBrowserInput";
import { applyHighlightsToHtml } from "@/lib/highlights/applySegments";
import TextDocumentReader, {
  type TextReaderContentDecorator,
} from "./TextDocumentReader";

const CANONICAL_HTML = "<p>Alpha beacon omega</p>";
const CANONICAL_TEXT = "Alpha beacon omega";

function renderLeaf(
  props: Partial<Parameters<typeof TextDocumentReader>[0]> = {},
) {
  return render(
    <TextDocumentReader
      mediaId="11111111-1111-4111-8111-111111111111"
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

describe("TextDocumentReader canonical content, input and hosted decoration ports", () => {
  it("keeps controls and zoom gestures separate from genuine reader movement", async () => {
    const intents: string[] = [];
    const destinations: string[] = [];
    renderLeaf({
      contentState: { status: "ready", renderedHtml: '<p><a href="#source">source link</a></p><p>Reader prose</p>' },
      onTrustedScrollIntent: (direction) => intents.push(direction),
      endContent: <button type="button" onClick={() => destinations.push("previous resource")}>previous resource</button>,
    });

    await userEvent.tab();
    expect(screen.getByRole("region", { name: "Document reading area" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("link", { name: "source link" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "previous resource" })).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(destinations).toEqual(["previous resource"]);
    expect(intents, "Space activating a reader navigation button must not publish reading intent").toEqual([]);

    await userEvent.tab({ shift: true });
    expect(screen.getByRole("link", { name: "source link" })).toHaveFocus();
    await userEvent.keyboard(" ");
    await userEvent.keyboard("{ArrowUp}");
    expect(intents).toEqual(["forward", "backward"]);

    const area = screen.getByRole("region", { name: "Document reading area" });
    const wheelEvents: { trusted: boolean; control: boolean }[] = [];
    area.addEventListener("wheel", (event) => {
      wheelEvents.push({ trusted: event.isTrusted, control: event.ctrlKey });
    }, { once: true });
    await userEvent.keyboard("{Control>}");
    try {
      await userEvent.wheel(area, { delta: { y: 100 } });
    } finally {
      await userEvent.keyboard("{/Control}");
    }
    expect(wheelEvents).toEqual([{ trusted: true, control: true }]);
    expect(intents, "trusted ctrl-wheel zoom must not publish reading intent").toEqual(["forward", "backward"]);
    await userEvent.wheel(area, { delta: { y: 100 } });
    await userEvent.wheel(area, { delta: { y: -100 } });
    expect(intents).toEqual(["forward", "backward", "forward", "backward"]);

    const proseRect = screen.getByText("Reader prose").getBoundingClientRect();
    const { x, y } = toTopLevelCdpCoordinate({
      x: proseRect.left + 20,
      y: proseRect.top + proseRect.height / 2,
    });
    const touchMoves: { trusted: boolean; contacts: number }[] = [];
    area.addEventListener("touchmove", (event) => {
      touchMoves.push({ trusted: event.isTrusted, contacts: event.touches.length });
    });
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
    try {
      await cdp().send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
      await cdp().send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }, { x: x + 40, y, id: 2 }] });
      await cdp().send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - 40, id: 1 }, { x: x + 40, y: y + 40, id: 2 }] });
      expect(touchMoves).toContainEqual({ trusted: true, contacts: 2 });
      expect(intents, "trusted multi-touch zoom must not publish reading intent").toEqual(["forward", "backward", "forward", "backward"]);
      await cdp().send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });

      await cdp().send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
      await cdp().send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - 40, id: 1 }] });
      expect(touchMoves).toContainEqual({ trusted: true, contacts: 1 });
      expect(intents).toEqual(["forward", "backward", "forward", "backward", "forward"]);
    } finally {
      await cdp().send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await cdp().send("Emulation.resetPageScaleFactor");
    }
  });

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
