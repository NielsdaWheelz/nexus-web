import { render } from "@testing-library/react";
import { cdp, commands } from "vitest/browser";
import { expect, it } from "vitest";
import { ResourceCache } from "@/lib/api/resourceCache";
import { createDocumentReaderSession } from "@/lib/reader/DocumentReaderSession";
import { createHostedReaderSource } from "@/lib/reader/ReaderDocumentSource";
import { HostedReaderProgressRuntime } from "@/lib/reader/hostedReaderProgress";
import { prepareReaderUnit } from "@/lib/reader/publicationDom";
import { decodeReaderPublicationUnit } from "@/lib/reader/publicationContract";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import HtmlRenderer from "../HtmlRenderer";

it("renders each original list marker once across actual published item continuations", async () => {
  const corpus: { cases: { name: string; numbers: (string | null)[] }[] } = JSON.parse(await commands.readFile("../../testdata/offline-reading/list-ordinals.json"));
  const publications: { name: string; units: unknown[] }[] = JSON.parse(await commands.readFile("../../testdata/offline-reading/list-render-units.json"));
  const accountId = crypto.randomUUID();
  const mediaId = "00000000-0000-4000-8000-000000000033";
  const runtime = new HostedReaderProgressRuntime(accountId, () => {});
  const session = createDocumentReaderSession({ mediaId, capacity: READER_CAPACITY,
    source: createHostedReaderSource({ accountId, cache: new ResourceCache({}, READER_CAPACITY.cache), capacity: READER_CAPACITY }),
    progress: runtime.createPort(mediaId),
  });
  try {
    const frames = await cdp().send("Page.getFrameTree");
    const frameId = frames.frameTree.childFrames?.find((frame) => frame.frame.name === "vitest-iframe")?.frame.id;
    if (frameId === undefined) throw new Error("Reader browser frame is absent");
    for (const publication of publications) {
      const source = corpus.cases.find((item) => item.name === publication.name);
      if (source === undefined) throw new Error("Published list has no independent source oracle");
      const markers: string[] = [];
      for (const [index, wire] of publication.units.entries()) {
        const unit = decodeReaderPublicationUnit(wire);
        const prepared = prepareReaderUnit({ session, unit, unitKey: `units/${index}.json`, highlights: [], headingLevelOffset: 0 });
        if (prepared.kind !== "Ready") throw new Error("A single bounded list unit exhausted DOM admission");
        const view = render(<HtmlRenderer preparedRoot={prepared.value.root} />);
        try {
          if (unit.render_end_cp > unit.render_start_cp) expect(prepared.value.root.getBoundingClientRect().height).toBeGreaterThan(0);
          const tree = await cdp().send("Accessibility.getFullAXTree", { frameId });
          for (const node of tree.nodes) {
            const value = node.name?.value;
            if (node.role?.value === "ListMarker" && typeof value === "string" && /^-?\d+\. $/.test(value)) markers.push(value.slice(0, -2));
          }
        } finally { view.unmount(); prepared.value.release(); }
      }
      // until-found keeps an ordinal-bearing CSS box, but its marker is hidden.
      // The nested unordered marker is outside the numbered-list contract.
      const expected = source.numbers.filter((number, index) => number !== null && !(source.name === "hidden-until-found" && index === 0));
      expect(markers.sort(), `continued item repeated its original marker: ${source.name}`).toEqual(expected.sort());
    }
  } finally { session.close(); runtime.close(); }
});
