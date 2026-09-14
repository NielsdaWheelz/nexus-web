import { expect, it } from "vitest";
import { buildCanonicalCursor } from "./canonicalCursor";
import { selectionToOffsets } from "./selectionToOffsets";

it("selects across source units without inserting their presentation paragraph separators", () => {
  const root = document.createElement("div");
  const first = document.createElement("p");
  const firstText = document.createTextNode("alpha");
  first.append(firstText);
  const second = document.createElement("p");
  const secondText = document.createTextNode("beta");
  second.append(secondText);
  root.append(first, second); document.body.append(root);
  const firstCursor = buildCanonicalCursor(first);
  const secondCursor = buildCanonicalCursor(second);
  const nodes = [...firstCursor.nodes, ...secondCursor.nodes.map((node) => ({ ...node, start: node.start + 6, end: node.end + 6 }))];
  const range = document.createRange(); range.setStart(firstText, 2); range.setEnd(secondText, 2);
  expect(selectionToOffsets(range, { nodes }, [{ start: 0, text: "alpha" }, { start: 5, text: " beta" }])).toEqual({
    success: true, startOffset: 2, endOffset: 8, selectedText: "pha be",
  });
  root.remove();
});
