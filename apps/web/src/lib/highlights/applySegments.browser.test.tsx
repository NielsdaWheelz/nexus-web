import { afterEach, expect, it, vi } from "vitest";
import { planHighlightsForDom } from "./applySegments";

afterEach(() => vi.unstubAllGlobals());

it("keeps private text out of canonical mismatch diagnostics", () => {
  const messages: unknown[] = [];
  vi.stubGlobal("console", { ...console, warn: (...args: unknown[]) => messages.push(args) });
  const root = document.createElement("p");
  root.append(document.createTextNode("private rendered text"));
  expect(planHighlightsForDom(root, "private source text", "fragment", []).kind).toBe("Mismatch");
  expect(messages).toEqual([["canonical_text_mismatch", {
    fragmentId: "fragment", emittedLength: 21, expectedLength: 19, firstDiffIdx: 8,
  }]]);
});

it("plans highlight nodes before modifying an admitted publication tree", () => {
  const root = document.createElement("div");
  const paragraph = document.createElement("p");
  paragraph.append(document.createTextNode("alpha beta gamma"));
  root.append(paragraph);
  const before = root.getElementsByTagName("*").length;
  const plan = planHighlightsForDom(root, "alpha beta gamma", "fragment", [{
    id: "highlight", start_offset: 6, end_offset: 10, color: "yellow", created_at: "2026-09-01T00:00:00Z",
  }]);
  expect(plan.kind).toBe("Ready");
  if (plan.kind !== "Ready") throw new Error("Canonical fixture did not validate");
  expect(root.getElementsByTagName("*").length, "planning mutated the publication before admission").toBe(before);
  expect(root.querySelector("[data-active-highlight-ids]")).toBeNull();
  const initialNodes = countNodes(root);
  expect(plan.apply()).toEqual({ failedIds: [], validationPassed: true });
  expect(root.querySelector("[data-active-highlight-ids='highlight']")?.textContent).toBe("beta");
  expect(root.textContent).toBe("alpha beta gamma");
  expect(countNodes(root) - initialNodes).toBeLessThanOrEqual(plan.additionalNodes);
});

function countNodes(root: Node): number {
  const cursor = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
  let count = 1;
  while (cursor.nextNode() !== null) count += 1;
  return count;
}
