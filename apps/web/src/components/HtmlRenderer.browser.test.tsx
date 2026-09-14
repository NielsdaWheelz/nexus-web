import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import HtmlRenderer from "./HtmlRenderer";

it("adopts the admitted publication nodes without reparsing or replacing a selected node", () => {
  const root = document.createElement("article");
  const paragraph = document.createElement("p");
  const text = document.createTextNode("bounded publication");
  paragraph.append(text);
  root.append(paragraph);
  const view = render(<HtmlRenderer preparedRoot={root} />, { reactStrictMode: true });
  expect(screen.getByText("bounded publication")).toBe(paragraph);
  const selection = document.getSelection();
  if (selection === null) throw new Error("Browser selection is unavailable");
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, 7);
  selection.removeAllRanges();
  selection.addRange(range);
  view.rerender(<HtmlRenderer preparedRoot={root} className="reader-update" />);
  expect(selection.toString()).toBe("bounded");
  view.unmount();
  expect(root.isConnected).toBe(false);
  selection.removeAllRanges();
});
