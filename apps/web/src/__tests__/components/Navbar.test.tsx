import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Navbar from "@/components/Navbar";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  usePathname: () => "/libraries",
}));

describe("Navbar", () => {
  it("renders the logo", () => {
    render(<Navbar />);
    expect(screen.getByText("Nexus")).toBeInTheDocument();
  });

  it("renders the libraries link", () => {
    render(<Navbar />);
    expect(screen.getByText("Libraries")).toBeInTheDocument();
  });

  it("toggles collapsed state", () => {
    const onToggle = vi.fn();
    render(<Navbar onToggle={onToggle} />);

    const toggleButton = screen.getByLabelText("Collapse navigation");
    fireEvent.click(toggleButton);

    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("shows expand button when collapsed", () => {
    const onToggle = vi.fn();
    render(<Navbar onToggle={onToggle} />);

    // Collapse
    const collapseButton = screen.getByLabelText("Collapse navigation");
    fireEvent.click(collapseButton);

    // Now should show expand button
    const expandButton = screen.getByLabelText("Expand navigation");
    expect(expandButton).toBeInTheDocument();
  });

  it("highlights active link", () => {
    render(<Navbar />);
    const librariesLink = screen.getByText("Libraries").closest("a");
    // CSS modules hash the class name, so check for partial match
    expect(librariesLink?.className).toMatch(/active/i);
  });
});
