import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DossierDocumentFrame, {
  buildDossierFrameDocument,
  DOSSIER_FIND_TRANSPORT_TIMEOUT_MS,
  type DossierDocumentFindCapability,
} from "@/components/dossier/DossierDocumentFrame";
import { DOSSIER_DOCUMENT_RUNTIME } from "@/components/dossier/dossierDocumentRuntime";
import { machineDocumentStyles } from "@/components/ui/MachineText";

const REVISION_REF = "artifact_revision:revision-1";

afterEach(() => {
  delete document.documentElement.dataset.theme;
  vi.useRealTimers();
});

describe("DossierDocumentFrame", () => {
  it("builds an opaque-origin document with CSP first and no navigation powers", () => {
    document.documentElement.dataset.theme = "light";
    render(
      <DossierDocumentFrame
        title="Bayesian inference"
        revisionRef={REVISION_REF}
        contentHtml={'<article><section id="why"><h2>Why it matters</h2></section></article>'}
        onCitation={vi.fn()}
        onFindCapabilityChange={vi.fn()}
        onFindRequested={vi.fn()}
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
    expect(DOSSIER_DOCUMENT_RUNTIME.toLowerCase()).not.toContain("</script");
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
        revisionRef={REVISION_REF}
        contentHtml={'<article><section id="one"><h2>One</h2></section></article>'}
        onCitation={onCitation}
        onFindCapabilityChange={vi.fn()}
        onFindRequested={vi.fn()}
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

  it("publishes one exact revision capability only after load and Ready in either order", async () => {
    const onFindCapabilityChange = vi.fn();
    const view = render(
      <DossierDocumentFrame
        title="Inference"
        revisionRef={REVISION_REF}
        contentHtml={'<article><section id="one"><h2>One</h2><p>Readable.</p></section></article>'}
        onCitation={vi.fn()}
        onFindCapabilityChange={onFindCapabilityChange}
        onFindRequested={vi.fn()}
      />,
    );
    const frame = screen.getByTitle(
      "Learning dossier: Inference",
    ) as HTMLIFrameElement;
    const channel =
      frame
        .getAttribute("srcdoc")
        ?.match(/data-nexus-channel="([a-f0-9]{32})"/)?.[1] ?? "";

    fireEvent(
      window,
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { channel, kind: "FindReady" },
      }),
    );
    expect(onFindCapabilityChange).not.toHaveBeenCalled();
    fireEvent.load(frame);
    await waitFor(() =>
      expect(onFindCapabilityChange).toHaveBeenCalledWith(
        expect.objectContaining({ revisionRef: REVISION_REF }),
      ),
    );
    const firstCapability = onFindCapabilityChange.mock.calls.find(
      ([value]) => value !== null,
    )?.[0] as DossierDocumentFindCapability | undefined;
    expect(firstCapability).toBeDefined();

    view.rerender(
      <DossierDocumentFrame
        title="Inference"
        revisionRef="artifact_revision:revision-2"
        contentHtml={'<article><section id="two"><h2>Two</h2><p>Changed.</p></section></article>'}
        onCitation={vi.fn()}
        onFindCapabilityChange={onFindCapabilityChange}
        onFindRequested={vi.fn()}
      />,
    );
    expect(onFindCapabilityChange).toHaveBeenCalledWith(null);
    expect(
      screen
        .getByTitle("Learning dossier: Inference")
        .getAttribute("srcdoc"),
    ).not.toContain(`data-nexus-channel="${channel}"`);
    expect(() => firstCapability?.setFindEnabled(false)).not.toThrow();
  });

  it("also latches load before the exact Ready response", async () => {
    const onFindCapabilityChange = vi.fn();
    render(
      <DossierDocumentFrame
        title="Inference"
        revisionRef={REVISION_REF}
        contentHtml="<article><p>Readable.</p></article>"
        onCitation={vi.fn()}
        onFindCapabilityChange={onFindCapabilityChange}
        onFindRequested={vi.fn()}
      />,
    );
    const frame = screen.getByTitle(
      "Learning dossier: Inference",
    ) as HTMLIFrameElement;
    const channel =
      frame
        .getAttribute("srcdoc")
        ?.match(/data-nexus-channel="([a-f0-9]{32})"/)?.[1] ?? "";

    fireEvent.load(frame);
    expect(onFindCapabilityChange).not.toHaveBeenCalled();
    fireEvent(
      window,
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { channel, kind: "FindReady" },
      }),
    );

    await waitFor(() =>
      expect(onFindCapabilityChange).toHaveBeenCalledWith(
        expect.objectContaining({ revisionRef: REVISION_REF }),
      ),
    );
  });

  it("reclaims its frame generation across Strict Mode effect replay", async () => {
    const onFindCapabilityChange = vi.fn();
    render(
      <StrictMode>
        <DossierDocumentFrame
          title="Inference"
          revisionRef={REVISION_REF}
          contentHtml="<article><p>Readable.</p></article>"
          onCitation={vi.fn()}
          onFindCapabilityChange={onFindCapabilityChange}
          onFindRequested={vi.fn()}
        />
      </StrictMode>,
    );
    const frame = screen.getByTitle(
      "Learning dossier: Inference",
    ) as HTMLIFrameElement;
    const channel =
      frame
        .getAttribute("srcdoc")
        ?.match(/data-nexus-channel="([a-f0-9]{32})"/)?.[1] ?? "";

    fireEvent.load(frame);
    fireEvent(
      window,
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { channel, kind: "FindReady" },
      }),
    );

    await waitFor(() =>
      expect(onFindCapabilityChange).toHaveBeenCalledWith(
        expect.objectContaining({ revisionRef: REVISION_REF }),
      ),
    );
  });

  it("strictly settles commands and focuses the frame after Return", async () => {
    const onFindCapabilityChange = vi.fn();
    render(
      <DossierDocumentFrame
        title="Inference"
        revisionRef={REVISION_REF}
        contentHtml={'<article><section id="one"><h2>One</h2><p>Readable.</p></section></article>'}
        onCitation={vi.fn()}
        onFindCapabilityChange={onFindCapabilityChange}
        onFindRequested={vi.fn()}
      />,
    );
    const frame = screen.getByTitle(
      "Learning dossier: Inference",
    ) as HTMLIFrameElement;
    const channel =
      frame
        .getAttribute("srcdoc")
        ?.match(/data-nexus-channel="([a-f0-9]{32})"/)?.[1] ?? "";
    fireEvent.load(frame);
    fireEvent(
      window,
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { channel, kind: "FindReady" },
      }),
    );
    await waitFor(() =>
      expect(onFindCapabilityChange).toHaveBeenCalledWith(
        expect.objectContaining({ revisionRef: REVISION_REF }),
      ),
    );
    const capability = onFindCapabilityChange.mock.calls.find(
      ([value]) => value !== null,
    )?.[0] as DossierDocumentFindCapability;
    const stubLoaded = new Promise<void>((resolve) => {
      frame.addEventListener("load", () => resolve(), { once: true });
    });
    frame.setAttribute(
      "srcdoc",
      "<!doctype html><html><body>Transport stub</body></html>",
    );
    await stubLoaded;

    const prepare = capability.prepare({
      sessionId: 1,
      signal: new AbortController().signal,
    });
    fireEvent(
      window,
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: {
          channel,
          kind: "FindPrepared",
          sessionId: 1,
          projectionLengthCp: 8,
          currentSection: { kind: "Absent" },
          extra: true,
        },
      }),
    );
    let settled = false;
    void prepare.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    fireEvent(
      window,
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: {
          channel,
          kind: "FindPrepared",
          sessionId: 1,
          projectionLengthCp: 8,
          currentSection: { kind: "Absent" },
        },
      }),
    );
    await expect(prepare).resolves.toEqual({
      projectionLengthCp: 8,
      currentSection: { kind: "Absent" },
    });

    const find = capability.find({
      sessionId: 1,
      queryId: 1,
      query: "read",
      scope: { kind: "EntireResource" },
      matchCase: false,
      wholeWord: false,
      signal: new AbortController().signal,
    });
    const exactResult = {
      kind: "FindResults",
      sessionId: 1,
      queryId: 1,
      result: {
        kind: "Ready",
        occurrences: [
          {
            ordinal: 0,
            startCp: 0,
            endCp: 4,
            snippet: [{ text: "read", emphasized: true }],
            section: { kind: "Absent" },
          },
        ],
      },
    };
    for (const candidate of [
      { ...exactResult, extra: true },
      { ...exactResult, sessionId: 2 },
      { ...exactResult, queryId: 2 },
      {
        ...exactResult,
        result: {
          ...exactResult.result,
          occurrences: [
            {
              ...exactResult.result.occurrences[0],
              endCp: 9,
            },
          ],
        },
      },
    ]) {
      fireEvent(
        window,
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { channel, ...candidate },
        }),
      );
    }
    fireEvent(
      window,
      new MessageEvent("message", {
        source: window,
        data: { channel, ...exactResult },
      }),
    );
    fireEvent(
      window,
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { channel: "wrong-channel", ...exactResult },
      }),
    );
    let findSettled = false;
    void find.finally(() => {
      findSettled = true;
    });
    await Promise.resolve();
    expect(findSettled).toBe(false);
    fireEvent(
      window,
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { channel, ...exactResult },
      }),
    );
    await expect(find).resolves.toEqual(exactResult.result);

    const activationController = new AbortController();
    const activation = capability.activate({
      sessionId: 1,
      queryId: 1,
      ordinal: 0,
      signal: activationController.signal,
    });
    activationController.abort();
    fireEvent(
      window,
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: {
          channel,
          kind: "FindActivated",
          sessionId: 1,
          queryId: 1,
          ordinal: 1,
        },
      }),
    );
    let activationSettled = false;
    void activation.finally(() => {
      activationSettled = true;
    });
    await Promise.resolve();
    expect(activationSettled).toBe(false);
    fireEvent(
      window,
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: {
          channel,
          kind: "FindActivated",
          sessionId: 1,
          queryId: 1,
          ordinal: 0,
        },
      }),
    );
    await expect(activation).resolves.toEqual({
      kind: "Activated",
      ordinal: 0,
    });

    const returnRequest = capability.returnToReadingPosition({
      sessionId: 1,
      signal: new AbortController().signal,
    });
    fireEvent(
      window,
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { channel, kind: "FindReturned", sessionId: 1 },
      }),
    );
    await expect(returnRequest).resolves.toEqual({ kind: "Returned" });
    expect(frame).toHaveFocus();
  });

  it("defects one unsettled command through the named transport timeout", async () => {
    vi.useFakeTimers();
    const onFindCapabilityChange = vi.fn();
    render(
      <DossierDocumentFrame
        title="Inference"
        revisionRef={REVISION_REF}
        contentHtml={'<article><p>Readable.</p></article>'}
        onCitation={vi.fn()}
        onFindCapabilityChange={onFindCapabilityChange}
        onFindRequested={vi.fn()}
      />,
    );
    const frame = screen.getByTitle(
      "Learning dossier: Inference",
    ) as HTMLIFrameElement;
    const channel =
      frame
        .getAttribute("srcdoc")
        ?.match(/data-nexus-channel="([a-f0-9]{32})"/)?.[1] ?? "";
    fireEvent.load(frame);
    fireEvent(
      window,
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { channel, kind: "FindReady" },
      }),
    );
    const capability = onFindCapabilityChange.mock.calls.find(
      ([value]) => value !== null,
    )?.[0] as DossierDocumentFindCapability;
    const stubLoaded = new Promise<void>((resolve) => {
      frame.addEventListener("load", () => resolve(), { once: true });
    });
    frame.setAttribute(
      "srcdoc",
      "<!doctype html><html><body>Transport stub</body></html>",
    );
    await stubLoaded;
    const pending = capability.prepare({
      sessionId: 1,
      signal: new AbortController().signal,
    });

    await vi.advanceTimersByTimeAsync(DOSSIER_FIND_TRANSPORT_TIMEOUT_MS);

    await expect(pending).rejects.toThrow("Dossier Find transport timed out");
  });
});
