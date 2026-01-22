import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
