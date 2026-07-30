import { describe, expect, it } from "vitest";

import { buildDomTextCursor } from "./domTextCursor";

function html(content: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = content;
  return root;
}

describe("buildDomTextCursor", () => {
  it("projects normalized visible text with exact DOM provenance", () => {
    const root = html(
      '<p>  Caf<span>e</span><em>\u0301</em>   noir</p>' +
        '<aside data-pane-find-exclude="true"><p>Controls</p></aside>' +
        "<p>🎉</p>",
    );
    const eNode = root.querySelector("span")!.firstChild as Text;
    const accentNode = root.querySelector("em")!.firstChild as Text;
    const emojiNode = root.querySelectorAll("p")[2]!.firstChild as Text;

    const cursor = buildDomTextCursor(
      root,
      (element) => element.hasAttribute("data-pane-find-exclude"),
    );

    expect(cursor.emitted).toBe("Café noir\n🎉");
    expect(cursor.length).toBe(11);
    expect(cursor.nodes.some(({ node }) => node.data.includes("Controls"))).toBe(
      false,
    );
    expect(cursor.provenance[3]).toEqual({
      start: 3,
      end: 4,
      spans: [
        { node: eNode, startUtf16: 0, endUtf16: 1 },
        { node: accentNode, startUtf16: 0, endUtf16: 1 },
      ],
    });
    expect(cursor.provenance[10]).toEqual({
      start: 10,
      end: 11,
      spans: [{ node: emojiNode, startUtf16: 0, endUtf16: 2 }],
    });
  });

  it("skips an excluded subtree without contributing block separators", () => {
    const root = html(
      "<p>Before</p>" +
        '<section data-pane-find-exclude="true"><p>Hidden</p></section>' +
        "<p>After</p>",
    );

    const cursor = buildDomTextCursor(
      root,
      (element) => element.hasAttribute("data-pane-find-exclude"),
    );

    expect(cursor.emitted).toBe("Before\nAfter");
    expect(cursor.nodes.map(({ node }) => node.data)).toEqual([
      "Before",
      "After",
    ]);
  });
});
