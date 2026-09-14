import { createRef, useRef } from "react";
import { render } from "@testing-library/react";
import { cdp, commands, page, server } from "vitest/browser";
import { expect, it } from "vitest";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { useReaderScrollPositioner } from "@/lib/reader/paneScroll";
import TextDocumentReader from "./TextDocumentReader";

const recipe: {
  prefix: string;
  row: string;
  suffix: string;
  profiles: { rows: number; html_bytes: number; sha256: string }[];
} = JSON.parse(await commands.readFile("../../testdata/capacity/reader-tables.json"));
const measurements: unknown[] = [];

function TableReader({ html }: { html: string }) {
  return <TextDocumentReader
    mediaId="11111111-1111-4111-8111-111111111111"
    scrollPositioner={useReaderScrollPositioner()}
    readerRootRef={useRef<HTMLDivElement>(null)} contentRef={useRef<HTMLDivElement>(null)}
    textViewportRef={useRef<HTMLDivElement>(null)} textEndRef={useRef<HTMLElement>(null)}
    readerThemeClassName="" readerSurfaceStyle={{}} focusMode="off" hyphenation="auto"
    contentState={{ status: "ready", renderedHtml: html }}
    onViewportReady={() => {}} onViewportScroll={() => {}} onTrustedScrollIntent={() => {}}
    endContent={null} onContentClick={() => {}} onContentPointerOver={() => {}}
    onContentPointerOut={() => {}} onContentFocus={() => {}} onContentBlur={() => {}}
  />;
}

// These are measurements of the existing complete reading unit, not deployment
// budget assertions. Process RSS is recorded separately by the test controller.
for (const profile of recipe.profiles) {
  for (const views of [1, 2]) {
    it(`measures intact table ${profile.html_bytes} bytes in ${views} visible reader views`, async () => {
      await page.viewport(views === 1 ? 390 : 1_280, 844);
      const html = recipe.prefix + recipe.row.repeat(profile.rows) + recipe.suffix;
      const bytes = new TextEncoder().encode(html);
      expect(bytes.byteLength).toBe(profile.html_bytes);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      expect(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(profile.sha256);
      await cdp().send("HeapProfiler.collectGarbage");
      const baseline = await cdp().send("Runtime.getHeapUsage");
      const baselineDom = await cdp().send("Memory.getDOMCounters");
      const host = createRef<HTMLDivElement>();
      let loaded: unknown;
      let loadedDom: unknown;
      let renderMs = 0;
      const start = performance.now();
      const view = render(<MobileChromeProvider><div ref={host} style={{ display: "flex", height: 800 }}>
        {Array.from({ length: views }, (_, index) => <div key={index} style={{ width: views === 1 ? 390 : 640, height: 800 }}><TableReader html={html} /></div>)}
      </div></MobileChromeProvider>);
      try {
        // Reading table geometry forces actual layout, not just HTML parsing.
        // eslint-disable-next-line testing-library/no-node-access -- capacity experiment must inspect every mounted table, including content outside the viewport
        const tables = host.current!.querySelectorAll("table");
        expect(tables.length).toBe(views);
        for (const table of tables) {
          expect(table.getBoundingClientRect().height).toBeGreaterThan(0);
          expect(table.caption?.textContent).toBe("Intact reader table");
          expect(table.rows.length).toBe(profile.rows + 1);
          expect(table.tHead!.rows[0]!.cells[0]!.getAttribute("scope")).toBe("col");
          expect(table.tBodies[0]!.rows[0]!.cells[0]!.getAttribute("scope")).toBe("row");
        }
        const selection = window.getSelection()!;
        const range = document.createRange();
        range.selectNodeContents(tables[0]!);
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        const prefix = "Intact reader tablerowalphabetagamma";
        expect(selection.getRangeAt(0).toString().length, "complete table selection lost rows").toBe(prefix.length + 4 * profile.rows);
        renderMs = performance.now() - start;
        loaded = await cdp().send("Runtime.getHeapUsage");
        loadedDom = await cdp().send("Memory.getDOMCounters");
        selection.removeAllRanges();
      } finally {
        view.unmount();
      }
      await cdp().send("HeapProfiler.collectGarbage");
      measurements.push({ profile, views, baseline, baselineDom, renderMs, loaded, loadedDom,
        released: await cdp().send("Runtime.getHeapUsage"), releasedDom: await cdp().send("Memory.getDOMCounters"),
      });
      const directory = server.config.env.NEXUS_TEST_RESULTS_DIR;
      const runId = server.config.env.NEXUS_TEST_EVIDENCE_RUN_ID;
      if (!/^[0-9a-f]{16}$/.test(runId) || !directory.startsWith("/") || !directory.endsWith(`/test-results/runs/${runId}`)) {
        throw new Error("Table experiment requires the controller-owned evidence directory");
      }
      const fixtureBytes = new TextEncoder().encode(await commands.readFile("../../testdata/capacity/reader-tables.json"));
      const fixtureDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", fixtureBytes));
      const evidence = JSON.stringify({ version: 1, runId,
        scope: "unqualified intact TextDocumentReader experiment; excludes hosted decorators, workspace and native WebView; no 64MiB qualification",
        fixture: { path: "testdata/capacity/reader-tables.json", sha256: Array.from(fixtureDigest, (byte) => byte.toString(16).padStart(2, "0")).join("") },
        measurements,
      });
      if (evidence.length > 16_384) throw new Error("Table experiment evidence exceeded its fixed diagnostic budget");
      await commands.writeFile(`${directory}/reader-table-capacity.json`, evidence);
    });
  }
}
