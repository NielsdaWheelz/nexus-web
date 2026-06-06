import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ReaderContentsNav from "./ReaderContentsNav";

describe("ReaderContentsNav", () => {
  it("navigates with the parsed anchor when a node is clicked", () => {
    const onNavigate = vi.fn();
    render(
      <ReaderContentsNav
        nodes={[
          {
            id: "toc-1",
            label: "Chapter 1",
            ordinal: 0,
            href: "chapter-1.xhtml#start",
            fragment_idx: 0,
            level: 1,
            depth: 0,
            section_id: "section-1",
            navigable: true,
            children: [],
          },
        ]}
        activeSectionId="section-1"
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Chapter 1" }));

    expect(onNavigate).toHaveBeenCalledWith({
      sectionId: "section-1",
      anchorId: "start",
    });
  });
});
