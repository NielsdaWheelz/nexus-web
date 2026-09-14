import { useRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { cdp, page, userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import "@/app/globals.css";
import { pdfReaderSession } from "../__tests__/pdfReaderSession";
import { onePagePdf } from "../__tests__/pdfFixtures";
import MarginRail from "./MarginRail";

it("releases a retired gutter's borrowed DOM while its physical read settles and preserves bounded visible pages", async () => {
  await page.viewport(1280, 800);
  const mediaId = "11111111-1111-4111-8111-111111111111";
  const pdf = onePagePdf("Gutter source");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await pdf.arrayBuffer()));
  const digest = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const fixture = await pdfReaderSession({ kind: "pdf", media_id: mediaId, reader_generation: 7, title: "Margin source", reader_contract_version: 1,
    page_count: 1, document_asset_ref: { key: "assets/document.pdf", bytes: pdf.size, sha256: digest } });
  const response = (label: string, next: string | null = null) => {
    const data = { items: [{ id: `margin:highlight:${mediaId}`, fact_id: `highlight:${mediaId}`, kind: "Highlight",
      label_excerpt: label, label_codepoints: label.length, excerpt: "Preferred authored note", excerpt_codepoints: 23,
      location: { kind: "PdfGeometry", page: 1, source_sha256: digest, quads: [{ x1: 10, y1: 20, x2: 100, y2: 20, x3: 100, y3: 35, x4: 10, y4: 35 }] },
      edge_id: null, stance: null }], total_count: 3, next_cursor: next };
    const bytes = new TextEncoder().encode(JSON.stringify({ data }));
    return new Response(bytes, { headers: { "Content-Type": "application/json", "Content-Length": String(bytes.length) } });
  };
  let held = true;
  const pending: ((response: Response) => void)[] = [];
  const read = fixture.read;
  let active = "";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const initial = read(String(input)); if (initial !== null) return initial;
    if (String(input).endsWith("/evidence/gutter")) {
      if (held) return new Promise<Response>((resolve) => pending.push(resolve));
      const query = JSON.parse(String(init?.body));
      return response(query.after === null ? "Current margin" : "Next visible fact", query.after === null ? "next-visible" : null);
    }
    throw new Error(`Unexpected gutter source read: ${String(input)}`);
  });
  function Reader() {
    const content = useRef<HTMLDivElement>(null);
    return <div style={{ position: "relative", width: 1200, height: 400, "--reader-measure": "600px", "--reader-margin-width": "220px" } as React.CSSProperties}>
      <div style={{ width: 1200, height: 400, overflow: "auto" }}>
        <div ref={content} role="region" aria-label="Borrowed reader source">
          <div className="page" data-page-number="1" data-nexus-page-scale="1" data-nexus-page-rotation="0"
            data-nexus-page-viewport-width="900" data-nexus-page-viewport-height="1200" data-nexus-page-dpi-scale="1"
            style={{ width: 900, height: 1200 }}>Original reading surface</div>
        </div>
      </div>
      <MarginRail session={fixture.session} contentRef={content} layoutKey={0} readTextParts={() => []}
        isPdf isMobile={false} filters={{ highlight: true, citation: true, link: true, synapse: true }} refreshToken={0} hasMarginFacts
        onOpenSidecar={() => { active = "sidecar"; }} onActivateItem={async (id) => { active = id; return { kind: "Located" }; }}
        onDismissSynapse={async () => {}} onDefect={(defect) => { if (defect !== null) throw defect.error; }} />
    </div>;
  }
  await fixture.load();
  const baseline = fixture.session.residency;
  const { unmount: unmountInitial } = render(<Reader />);
  let view: ReturnType<typeof render> | null = null;
  try {
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));
    const retired = new WeakRef(screen.getByRole("region", { name: "Borrowed reader source" }));
    expect(retired.deref()?.isConnected).toBe(true);
    unmountInitial();
    expect(fixture.session.residency.payloadBytes, "cancelled gutter read lost its physical scratch reservation").toBeGreaterThan(baseline.payloadBytes);
    await cdp().send("HeapProfiler.collectGarbage");
    expect(retired.deref(), "held gutter response retained the retired source DOM").toBeUndefined();
    held = false;
    for (const finish of pending) finish(response("Retired margin"));
    await waitFor(() => expect(fixture.session.residency).toEqual(baseline));
    view = render(<Reader />);
    await screen.findByRole("button", { name: /Current margin/ });
    expect(screen.queryByText("Retired margin")).toBeNull();
    expect(screen.getByText("Preferred authored note")).toBeVisible();
    expect(screen.getByRole("button", { name: "+2 more" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Next margin page" }));
    await screen.findByRole("button", { name: /Next visible fact/ });
    expect(screen.queryByText("Current margin")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Next visible fact/ }));
    expect(active).toBe(`highlight:${mediaId}`);
    view.unmount();
    await waitFor(() => expect(fixture.session.residency, "retired margin retained source rows or DOM charges").toEqual(baseline));
  } finally { held = false; for (const finish of pending) finish(response("Retired margin")); unmountInitial(); view?.unmount(); fixture.close(); vi.unstubAllGlobals(); }
});
