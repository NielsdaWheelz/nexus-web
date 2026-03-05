import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CSSProperties } from "react";
import styles from "@/app/(authenticated)/media/[id]/page.module.css";

function renderReaderScopedElements(style: CSSProperties) {
  render(
    <div style={style}>
      <div className={styles.tocSection} data-testid="toc-section">
        <button type="button" className={styles.tocToggle}>
          Table of Contents
        </button>
        <button type="button" className={styles.tocLink}>
          Toc Link
        </button>
        <button type="button" className={`${styles.tocLink} ${styles.tocActive}`}>
          Active Toc Link
        </button>
        <span className={styles.tocLabel}>Toc Label</span>
      </div>

      <div className={styles.loading}>Loading state</div>
      <div className={styles.empty}>Empty state</div>
      <div className={styles.error}>Error state</div>
    </div>
  );
}

describe("Media page reader-scoped styles", () => {
  it("prefers reader tokens for EPUB TOC and status states", () => {
    renderReaderScopedElements({
      "--reader-bg-secondary": "rgb(10, 20, 30)",
      "--reader-text": "rgb(70, 80, 90)",
      "--reader-text-secondary": "rgb(100, 110, 120)",
      "--reader-text-muted": "rgb(130, 140, 150)",
      "--reader-border": "rgb(160, 170, 180)",
      "--reader-border-subtle": "rgb(190, 200, 210)",
      "--reader-accent": "rgb(220, 230, 240)",
      "--color-bg-secondary": "rgb(1, 2, 3)",
      "--color-text": "rgb(7, 8, 9)",
      "--color-text-secondary": "rgb(11, 12, 13)",
      "--color-text-muted": "rgb(14, 15, 16)",
      "--color-border": "rgb(17, 18, 19)",
      "--color-border-subtle": "rgb(21, 22, 23)",
      "--color-accent": "rgb(24, 25, 26)",
    } as CSSProperties);

    const tocSection = screen.getByTestId("toc-section");
    const tocToggle = screen.getByRole("button", { name: "Table of Contents" });
    const tocLink = screen.getByRole("button", { name: "Toc Link" });
    const tocActive = screen.getByRole("button", { name: "Active Toc Link" });
    const tocLabel = screen.getByText("Toc Label");
    const loading = screen.getByText("Loading state");
    const empty = screen.getByText("Empty state");
    const error = screen.getByText("Error state");

    expect(getComputedStyle(tocSection).borderBottomColor).toBe("rgb(190, 200, 210)");
    expect(getComputedStyle(tocToggle).color).toBe("rgb(100, 110, 120)");
    expect(getComputedStyle(tocLink).color).toBe("rgb(220, 230, 240)");
    expect(getComputedStyle(tocActive).backgroundColor).toBe("rgb(10, 20, 30)");
    expect(getComputedStyle(tocLabel).color).toBe("rgb(130, 140, 150)");
    expect(getComputedStyle(loading).color).toBe("rgb(130, 140, 150)");
    expect(getComputedStyle(empty).color).toBe("rgb(130, 140, 150)");
    expect(getComputedStyle(error).backgroundColor).toBe("rgb(10, 20, 30)");
    expect(getComputedStyle(error).borderTopColor).toBe("rgb(160, 170, 180)");
    expect(getComputedStyle(error).color).toBe("rgb(100, 110, 120)");
  });

  it("falls back to global tokens outside reader-scoped contexts", () => {
    renderReaderScopedElements({
      "--color-bg-secondary": "rgb(31, 32, 33)",
      "--color-text": "rgb(37, 38, 39)",
      "--color-text-secondary": "rgb(41, 42, 43)",
      "--color-text-muted": "rgb(44, 45, 46)",
      "--color-border": "rgb(47, 48, 49)",
      "--color-border-subtle": "rgb(51, 52, 53)",
      "--color-accent": "rgb(54, 55, 56)",
    } as CSSProperties);

    const tocSection = screen.getByTestId("toc-section");
    const tocToggle = screen.getByRole("button", { name: "Table of Contents" });
    const tocLink = screen.getByRole("button", { name: "Toc Link" });
    const loading = screen.getByText("Loading state");
    const error = screen.getByText("Error state");

    expect(getComputedStyle(tocSection).borderBottomColor).toBe("rgb(51, 52, 53)");
    expect(getComputedStyle(tocToggle).color).toBe("rgb(41, 42, 43)");
    expect(getComputedStyle(tocLink).color).toBe("rgb(54, 55, 56)");
    expect(getComputedStyle(loading).color).toBe("rgb(44, 45, 46)");
    expect(getComputedStyle(error).backgroundColor).toBe("rgb(31, 32, 33)");
    expect(getComputedStyle(error).borderTopColor).toBe("rgb(47, 48, 49)");
    expect(getComputedStyle(error).color).toBe("rgb(41, 42, 43)");
  });
});
