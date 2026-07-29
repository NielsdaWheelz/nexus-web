import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DossierDocumentFrame, {
  buildDossierFrameDocument,
  DOSSIER_CITATION_BRIDGE,
} from "@/components/dossier/DossierDocumentFrame";
import { machineDocumentStyles } from "@/components/ui/MachineText";

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe("DossierDocumentFrame", () => {
  it("builds an opaque-origin document with CSP first and no navigation powers", () => {
    document.documentElement.dataset.theme = "light";
    render(
      <DossierDocumentFrame
        title="Bayesian inference"
        contentHtml={'<article><section id="why"><h2>Why it matters</h2></section></article>'}
        onCitation={vi.fn()}
      />,
    );

    const frame = screen.getByTitle("Learning dossier: Bayesian inference");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    const srcDoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toMatch(
      /^<!doctype html><html[^>]+><head><meta http-equiv="Content-Security-Policy"/,
    );
    expect(srcDoc).toContain("default-src 'none'");
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc).toContain("form-action 'none'");
    expect(srcDoc).not.toContain("allow-same-origin");
    expect(srcDoc).toContain('<section id="why"><h2>Why it matters</h2>');
  });

  it("keeps hostile title text out of raw-text contexts", () => {
    const srcDoc = buildDossierFrameDocument({
      title: `</title><script>alert(1)</script><!--]]>`,
      contentHtml: "<article><section id=\"safe\"><h2>Safe</h2></section></article>",
      theme: "dark",
      nonce: "00112233445566778899aabbccddeeff",
      channel: "ffeeddccbbaa99887766554433221100",
    });

    expect(srcDoc).toContain(
      "&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;!--]]&gt;",
    );
    expect(DOSSIER_CITATION_BRIDGE.toLowerCase()).not.toContain("</script");
    for (const theme of ["light", "dark"] as const) {
      const css = machineDocumentStyles(theme).toLowerCase();
      expect(css).not.toContain("</style");
      expect(css).not.toContain("<!--");
      expect(css).not.toContain("]]>");
    }
  });

  it("emits the exact nonce-bound CSP contract", () => {
    const nonce = "00112233445566778899aabbccddeeff";
    const srcDoc = buildDossierFrameDocument({
      title: "Inference",
      contentHtml: "<article><section id=\"safe\"><h2>Safe</h2></section></article>",
      theme: "dark",
      nonce,
      channel: "ffeeddccbbaa99887766554433221100",
    });
    const parsed = new DOMParser().parseFromString(srcDoc, "text/html");
    expect(
      parsed.head.firstElementChild?.getAttribute("content"),
    ).toBe(
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`,
    );
  });

  it("accepts only the exact frame window, channel, and Citation payload", () => {
    const onCitation = vi.fn();
    render(
      <DossierDocumentFrame
        title="Inference"
        contentHtml={'<article><section id="one"><h2>One</h2></section></article>'}
        onCitation={onCitation}
      />,
    );
    const frame = screen.getByTitle(
      "Learning dossier: Inference",
    ) as HTMLIFrameElement;
    const srcDoc = frame.getAttribute("srcdoc") ?? "";
    const channel = srcDoc.match(/data-nexus-channel="([a-f0-9]{32})"/)?.[1];
    expect(channel).toBeTruthy();

    fireEvent(
      window,
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { channel, kind: "Citation", ordinal: 2 },
      }),
    );
    fireEvent(
      window,
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { channel, kind: "Citation", ordinal: 3, href: "https://evil.test" },
      }),
    );
    fireEvent(
      window,
      new MessageEvent("message", {
        source: window,
        data: { channel, kind: "Citation", ordinal: 4 },
      }),
    );

    expect(onCitation).toHaveBeenCalledOnce();
    expect(onCitation).toHaveBeenCalledWith(2);
  });
});
