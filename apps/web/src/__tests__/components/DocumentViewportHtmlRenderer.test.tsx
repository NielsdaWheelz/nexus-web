import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import HtmlRenderer from "@/components/HtmlRenderer";
import DocumentViewport from "@/components/workspace/DocumentViewport";

describe("DocumentViewport + HtmlRenderer", () => {
  it("allows horizontal overflow for wide non-pdf content", () => {
    render(
      <div style={{ width: "320px", height: "120px" }}>
        <DocumentViewport>
          <HtmlRenderer
            htmlSanitized={'<div style="width: 1200px; height: 32px;">wide article content</div>'}
          />
        </DocumentViewport>
      </div>
    );

    const viewport = screen.getByTestId("document-viewport");
    expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
  });
});
