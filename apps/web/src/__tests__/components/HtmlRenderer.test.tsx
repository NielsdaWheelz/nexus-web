import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CSSProperties } from "react";
import HtmlRenderer from "@/components/HtmlRenderer";

describe("HtmlRenderer", () => {
  it("renders sanitized HTML content", () => {
    const html = "<p>Hello <strong>World</strong></p>";
    render(<HtmlRenderer htmlSanitized={html} />);

    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("World")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    const html = "<p>Test</p>";
    const { container } = render(
      <HtmlRenderer htmlSanitized={html} className="custom-class" />
    );

    expect(container.firstChild).toHaveClass("custom-class");
  });

  it("renders links with proper attributes", () => {
    const html =
      '<a href="https://example.com" rel="noopener noreferrer" target="_blank">Link</a>';
    render(<HtmlRenderer htmlSanitized={html} />);

    const link = screen.getByText("Link");
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders images", () => {
    const html = '<img src="https://example.com/img.png" alt="Test image" />';
    render(<HtmlRenderer htmlSanitized={html} />);

    const img = screen.getByAltText("Test image");
    expect(img).toHaveAttribute("src", "https://example.com/img.png");
  });

  it("renders lists correctly", () => {
    const html = "<ul><li>Item 1</li><li>Item 2</li></ul>";
    render(<HtmlRenderer htmlSanitized={html} />);

    expect(screen.getByText("Item 1")).toBeInTheDocument();
    expect(screen.getByText("Item 2")).toBeInTheDocument();
  });

  it("renders blockquotes", () => {
    const html = "<blockquote>A wise quote</blockquote>";
    render(<HtmlRenderer htmlSanitized={html} />);

    expect(screen.getByText("A wise quote")).toBeInTheDocument();
  });

  it("prefers reader-scoped theme tokens when they are present", () => {
    const html = `
      <p>Body text <code>inline code</code></p>
      <blockquote>Reader quote</blockquote>
      <a href="https://example.com">Reader link</a>
      <table><thead><tr><th>Head</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>
    `;
    const style = {
      "--reader-text": "rgb(10, 20, 30)",
      "--reader-text-secondary": "rgb(40, 50, 60)",
      "--reader-bg-secondary": "rgb(70, 80, 90)",
      "--reader-surface": "rgb(100, 110, 120)",
      "--reader-border": "rgb(130, 140, 150)",
      "--reader-accent": "rgb(160, 170, 180)",
      "--reader-accent-hover": "rgb(190, 200, 210)",
      "--color-text": "rgb(210, 0, 0)",
      "--color-text-secondary": "rgb(0, 210, 0)",
      "--color-bg-secondary": "rgb(0, 0, 210)",
      "--color-surface": "rgb(210, 210, 0)",
      "--color-border": "rgb(210, 0, 210)",
      "--color-accent": "rgb(0, 210, 210)",
      "--color-accent-hover": "rgb(140, 140, 140)",
    } as CSSProperties;

    render(
      <div style={style}>
        <HtmlRenderer htmlSanitized={html} />
      </div>
    );

    const bodyText = screen.getByText("Body text");
    const renderer = bodyText.closest("div") as HTMLElement;
    const blockquote = screen.getByText("Reader quote").closest("blockquote") as HTMLElement;
    const inlineCode = screen.getByText("inline code");
    const link = screen.getByText("Reader link");
    const th = screen.getByText("Head");
    const td = screen.getByText("Cell");

    expect(getComputedStyle(renderer).color).toBe("rgb(10, 20, 30)");
    expect(getComputedStyle(blockquote).color).toBe("rgb(40, 50, 60)");
    expect(getComputedStyle(blockquote).backgroundColor).toBe("rgb(70, 80, 90)");
    expect(getComputedStyle(blockquote).borderLeftColor).toBe("rgb(160, 170, 180)");
    expect(getComputedStyle(inlineCode).backgroundColor).toBe("rgb(100, 110, 120)");
    expect(getComputedStyle(link).color).toBe("rgb(160, 170, 180)");
    expect(getComputedStyle(th).backgroundColor).toBe("rgb(70, 80, 90)");
    expect(getComputedStyle(td).borderTopColor).toBe("rgb(130, 140, 150)");
  });

  it("falls back to global tokens when reader tokens are absent", () => {
    const html = `
      <p>Fallback body</p>
      <blockquote>Fallback quote</blockquote>
      <a href="https://example.com">Fallback link</a>
    `;
    const style = {
      "--color-text": "rgb(11, 22, 33)",
      "--color-text-secondary": "rgb(44, 55, 66)",
      "--color-bg-secondary": "rgb(77, 88, 99)",
      "--color-accent": "rgb(111, 122, 133)",
    } as CSSProperties;

    render(
      <div style={style}>
        <HtmlRenderer htmlSanitized={html} />
      </div>
    );

    const bodyText = screen.getByText("Fallback body");
    const renderer = bodyText.closest("div") as HTMLElement;
    const blockquote = screen.getByText("Fallback quote").closest("blockquote") as HTMLElement;
    const link = screen.getByText("Fallback link");

    expect(getComputedStyle(renderer).color).toBe("rgb(11, 22, 33)");
    expect(getComputedStyle(blockquote).color).toBe("rgb(44, 55, 66)");
    expect(getComputedStyle(blockquote).backgroundColor).toBe("rgb(77, 88, 99)");
    expect(getComputedStyle(link).color).toBe("rgb(111, 122, 133)");
  });
});
