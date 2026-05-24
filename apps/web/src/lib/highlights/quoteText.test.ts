import { describe, expect, it } from "vitest";
import type { RetrievalLocator } from "@/lib/api/sse/locators";
import {
  buildQuoteSelector,
  getLocatorQuoteParts,
  readPdfQuoteTextWindow,
} from "./quoteText";

describe("buildQuoteSelector", () => {
  it("omits empty and nullish prefix/suffix", () => {
    expect(buildQuoteSelector({ exact: "hi" })).toEqual({ exact: "hi" });
    expect(
      buildQuoteSelector({ exact: "hi", prefix: "", suffix: null }),
    ).toEqual({ exact: "hi" });
    expect(
      buildQuoteSelector({ exact: "hi", prefix: "a", suffix: "b" }),
    ).toEqual({ exact: "hi", prefix: "a", suffix: "b" });
  });
});

describe("getLocatorQuoteParts", () => {
  it("returns prefix/suffix for pdf_page_geometry only", () => {
    const pdfLocator: RetrievalLocator = {
      type: "pdf_page_geometry",
      media_id: "m",
      page_number: 1,
      quads: [],
      exact: "x",
      prefix: "p",
      suffix: "s",
    };
    expect(getLocatorQuoteParts(pdfLocator)).toEqual({
      prefix: "p",
      suffix: "s",
    });
  });

  it("omits empty pdf prefix/suffix", () => {
    const pdfLocator: RetrievalLocator = {
      type: "pdf_page_geometry",
      media_id: "m",
      page_number: 1,
      quads: [],
      exact: "x",
      prefix: "",
      suffix: null,
    };
    expect(getLocatorQuoteParts(pdfLocator)).toEqual({});
  });

  it("returns empty for non-pdf locators", () => {
    const textLocator: RetrievalLocator = {
      type: "web_text_offsets",
      media_id: "m",
      fragment_id: "f",
      start_offset: 0,
      end_offset: 5,
    };
    expect(getLocatorQuoteParts(textLocator)).toEqual({});
  });
});

describe("readPdfQuoteTextWindow", () => {
  it("returns just exact when text layer is missing", () => {
    const root = document.createElement("div");
    root.textContent = "Hello world";
    document.body.appendChild(root);
    const range = document.createRange();
    range.selectNodeContents(root.firstChild!);
    const result = readPdfQuoteTextWindow(range, null);
    expect(result).toEqual({ exact: "Hello world" });
    document.body.removeChild(root);
  });

  it("captures prefix and suffix when text layer is provided", () => {
    const root = document.createElement("div");
    root.textContent = "alpha beta gamma";
    document.body.appendChild(root);
    const range = document.createRange();
    const textNode = root.firstChild as Text;
    range.setStart(textNode, 6);
    range.setEnd(textNode, 10);
    const result = readPdfQuoteTextWindow(range, root);
    expect(result.exact).toBe("beta");
    expect(result.prefix).toBe("alpha");
    expect(result.suffix).toBe("gamma");
    expect(result.pageTextStartOffset).toBe(6);
    expect(result.pageTextEndOffset).toBe(10);
    document.body.removeChild(root);
  });
});
