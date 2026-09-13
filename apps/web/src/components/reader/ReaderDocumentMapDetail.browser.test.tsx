import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import "@/app/globals.css";
import { absent, present } from "@/lib/api/presence";
import type { MediaNavigation } from "@/lib/media/readerNavigation";
import { buildReaderDocumentStructure } from "@/lib/reader/readerDocumentPosition";
import ReaderDocumentMapDetail from "./ReaderDocumentMapDetail";

it("pins section detail during navigation and exposes targetless groups and inferred entries honestly", () => {
  const navigation: MediaNavigation = {
    media_id: "book",
    kind: "epub",
    generation: 1,
    fragments: [{ fragment_id: "text", fragment_idx: 0, char_count: 1000 }],
    sections: [
      {
        section_id: "middle", label: "Middle", parent_section_id: absent(),
        target: { fragment_id: "text", offset: 100 },
        extent: present({ start: { fragment_id: "text", offset: 100 }, end: { fragment_id: "text", offset: 400 } }),
        source: "Heading", anchor_id: absent(),
      },
      {
        section_id: "last", label: "Last", parent_section_id: absent(),
        target: { fragment_id: "text", offset: 400 },
        extent: present({ start: { fragment_id: "text", offset: 400 }, end: { fragment_id: "text", offset: 1000 } }),
        source: "InferredNumberedEntry", anchor_id: absent(),
      },
    ],
    toc_nodes: [{ id: "group", label: "Collected entries", section_id: absent(), children: [
      { id: "middle", label: "Middle", section_id: present("middle"), children: [] },
      { id: "last", label: "Last", section_id: present("last"), children: [] },
    ] }],
    landmarks: [], page_list: [],
  };
  const structure = buildReaderDocumentStructure(navigation);
  let activatedSection = "";
  const view = (offset: number) => (
    <div style={{ height: 600 }}>
      <ReaderDocumentMapDetail
        navigation={navigation} structure={structure} currentOffset={present(offset)}
        visibleRange={present({ start: offset / 1000, end: (offset + 50) / 1000 })}
        markers={[]} onNavigateSection={(sectionId) => { activatedSection = sectionId; }}
        onActivateMarker={() => undefined} onRevealCurrent={() => undefined} onReturn={absent()}
      />
    </div>
  );
  const { rerender } = render(view(250));
  expect(screen.getByText("section 50%")).toBeVisible();
  const outline = screen.getByRole("button", { name: "Last numbered entry (inferred)" });
  fireEvent.click(outline);
  expect(activatedSection).toBe("last");
  rerender(view(700));
  expect(screen.getByText("outside this section")).toBeVisible();
  expect(screen.getByRole("navigation", { name: "Map scope" })).toHaveTextContent("Middle");
  expect(screen.getByRole("button", { name: "Last numbered entry (inferred)" })).toHaveAttribute("aria-current", "location");
  expect(screen.queryByTestId("reader-current-position")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Collected entries"));
  expect(outline).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "current section" }));
  expect(screen.getByText("section 50%")).toBeVisible();
  expect(screen.getByTestId("reader-current-position")).toBeInTheDocument();
});

