import { render, screen } from "@testing-library/react";
import { cdp, commands } from "vitest/browser";
import { expect, it } from "vitest";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "@/lib/reader/DocumentReaderSession";
import { createHostedReaderSource } from "@/lib/reader/ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "@/lib/reader/hostedReaderProgress";
import { prepareReaderUnit } from "@/lib/reader/publicationDom";
import { decodeReaderPublicationDescriptor, decodeReaderPublicationUnit } from "@/lib/reader/publicationContract";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import { expectRecord, expectString } from "@/lib/validation";
import HtmlRenderer from "../HtmlRenderer";

it("preserves table, row and cell access in real publication excerpts while ordinary tables retain their source spans", async () => {
  const fixture = expectRecord(JSON.parse(await commands.readFile("../../testdata/offline-reading/source-table-schema-2-members.json")), "table publication fixture");
  const members = expectRecord(fixture.members, "table publication members");
  const descriptor = decodeReaderPublicationDescriptor(JSON.parse(expectString(members["descriptor.json"], "table descriptor")));
  const accountId = crypto.randomUUID();
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const session = createDocumentReaderSession({ mediaId: descriptor.media_id, capacity: READER_CAPACITY,
    source: createHostedReaderSource({ accountId, cache: new ResourceCache({}, READER_CAPACITY.cache), capacity: READER_CAPACITY }),
    progress: runtime.createPort(descriptor.media_id) });
  const frames = await cdp().send("Page.getFrameTree");
  const frameId = frames.frameTree.childFrames?.find((frame) => frame.frame.name === "vitest-iframe")?.frame.id;
  if (frameId === undefined) throw new Error("Reader browser frame is absent");
  let ordinarySeen = false;
  let captionSeen = false;
  try {
    for (const [key, raw] of Object.entries(members)) {
      if (!key.startsWith("units/")) continue;
      const unit = decodeReaderPublicationUnit(JSON.parse(expectString(raw, "table source unit")));
      if (unit.table_contexts.length === 0) continue;
      const prepared = prepareReaderUnit({ session, unit, unitKey: key, highlights: [], headingLevelOffset: 0 });
      if (prepared.kind !== "Ready") throw new Error("One bounded source table excerpt exhausted DOM admission");
      const view = render(<HtmlRenderer preparedRoot={prepared.value.root} />);
      try {
        const tree = await cdp().send("Accessibility.getFullAXTree", { frameId });
        const roles = tree.nodes.filter((node) => !node.ignored).map((node) => node.role?.value);
        expect(roles, `published table excerpt lost its accessible table role: ${key}`).toContain("table");
        expect(roles, `published table excerpt lost its accessible rows: ${key}`).toContain("row");
        expect(roles, `published table excerpt lost its accessible cells: ${key}`).toContain("cell");
        for (const context of unit.table_contexts) {
          if (context.caption?.unit_key === key) {
            captionSeen = true;
            expect(Array.from(unit.canonical_text).slice(context.caption.start_cp - unit.start_cp,
              context.caption.end_cp - unit.start_cp).join(""), "late caption lost its exact authored source range").toBe("late caption");
            const table = screen.getByRole("table", { name: "late caption" });
            expect(table.getAttribute("data-nexus-table")).toBe(String(context.table_ordinal));
            expect(screen.getByText("late caption", { selector: "caption" }), "late source caption did not name its excerpt").toBeVisible();
          }

          for (const cell of context.cells) {
            const element = [...screen.queryAllByRole("cell"), ...screen.queryAllByRole("columnheader"), ...screen.queryAllByRole("rowheader")].find((node) => node.getAttribute("data-nexus-table") === String(context.table_ordinal) &&
              node.getAttribute("data-nexus-row") === String(cell.row) && node.getAttribute("data-nexus-column") === String(cell.column));
            if (element === undefined) throw new Error("Source cell has no rendered coordinates");
            expect(element.getAttribute("aria-rowindex")).toBe(String(cell.row + 1));
            expect(element.getAttribute("aria-colindex")).toBe(String(cell.column + 1));
            expect(element.getBoundingClientRect().width).toBeGreaterThan(0);
            expect(element.getBoundingClientRect().height).toBeGreaterThan(0);
            expect(element.hasAttribute("rowspan") || element.hasAttribute("colspan"), "excerpt retained an operative whole-table span").toBe(false);
          }
        }
        const ordinary = screen.getAllByRole("table").find((node) => !node.hasAttribute("data-nexus-table"));
        if (ordinary !== undefined) {
          ordinarySeen = true;
          const cell = screen.getByText("ordinary", { exact: true });
          expect(cell?.textContent).toBe("ordinary");
          expect(cell?.getAttribute("rowspan")).toBe("2");
          expect(cell?.getAttribute("colspan")).toBe("2");
          expect(ordinary.getBoundingClientRect().height).toBeGreaterThan(0);
        }
      } finally { view.unmount(); prepared.value.release(); }
    }
    expect(captionSeen, "published late caption never reached the reader").toBe(true);
    expect(ordinarySeen, "published ordinary table never reached the reader").toBe(true);
  } finally { session.close(); runtime.close(); }
});
