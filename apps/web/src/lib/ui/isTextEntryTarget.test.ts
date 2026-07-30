import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTextEntryTarget } from "@/lib/ui/isTextEntryTarget";

class TestElement extends EventTarget {
  readonly tagName: string;
  readonly parent: TestElement | null;
  readonly attributes: Readonly<Record<string, string>>;

  constructor(
    tagName: string,
    attributes: Readonly<Record<string, string>> = {},
    parent: TestElement | null = null,
  ) {
    super();
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
    this.parent = parent;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  closest(selector: string): TestElement | null {
    if (
      selector === "[contenteditable]" &&
      this.getAttribute("contenteditable") !== null
    ) {
      return this;
    }
    if (
      selector === "[role='textbox']" &&
      this.getAttribute("role") === "textbox"
    ) {
      return this;
    }
    return this.parent?.closest(selector) ?? null;
  }
}

describe("isTextEntryTarget", () => {
  beforeEach(() => {
    vi.stubGlobal("Element", TestElement);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["textarea", new TestElement("textarea")],
    ["omitted input type", new TestElement("input")],
    ["text input", new TestElement("input", { type: "text" })],
    ["search input", new TestElement("input", { type: "search" })],
    ["email input", new TestElement("input", { type: "email" })],
    ["URL input", new TestElement("input", { type: "URL" })],
    ["telephone input", new TestElement("input", { type: "tel" })],
    ["password input", new TestElement("input", { type: "password" })],
    ["number input", new TestElement("input", { type: "number" })],
    [
      "contenteditable descendant",
      new TestElement(
        "span",
        {},
        new TestElement("div", { contenteditable: "plaintext-only" }),
      ),
    ],
    [
      "ARIA textbox descendant",
      new TestElement("span", {}, new TestElement("div", { role: "textbox" })),
    ],
  ])("matches %s", (_label, target) => {
    expect(isTextEntryTarget(target)).toBe(true);
  });

  it.each([
    ["select", new TestElement("select")],
    ["checkbox", new TestElement("input", { type: "checkbox" })],
    ["radio", new TestElement("input", { type: "radio" })],
    ["range", new TestElement("input", { type: "range" })],
    ["button", new TestElement("button")],
    ["explicitly non-editable content", new TestElement("div", { contenteditable: "false" })],
    ["ARIA checkbox", new TestElement("div", { role: "checkbox" })],
    ["non-element target", new EventTarget()],
  ])("rejects %s", (_label, target) => {
    expect(isTextEntryTarget(target)).toBe(false);
  });
});
