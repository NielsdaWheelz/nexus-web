import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import DossierDocumentFrame, {
  buildDossierFrameDocument,
} from "@/components/dossier/DossierDocumentFrame";

const CHANNEL = "ffeeddccbbaa99887766554433221100";
const NONCE = "00112233445566778899aabbccddeeff";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

it("preserves Follow and deliberate Fork citation disposition across the document boundary", async () => {
  const runtimeFrame = document.createElement("iframe");
  const runtimeMessages: unknown[] = [];
  const captureRuntimeMessage = (event: MessageEvent) => {
    if (event.source === runtimeFrame.contentWindow) {
      runtimeMessages.push(event.data);
    }
  };
  window.addEventListener("message", captureRuntimeMessage);
  document.body.append(runtimeFrame);
  runtimeFrame.srcdoc = buildDossierFrameDocument({
    title: "Citation disposition",
    contentHtml:
      '<article><button class="dossier-citation" data-nexus-citation="2">[2]</button></article>',
    theme: "light",
    nonce: NONCE,
    channel: CHANNEL,
  });
  await new Promise<void>((resolve) => {
    runtimeFrame.addEventListener("load", () => resolve(), { once: true });
  });

  const runtimeDocument = runtimeFrame.contentDocument;
  if (runtimeDocument === null) {
    throw new Error("Dossier runtime did not publish its citation control.");
  }
  const citation = within(runtimeDocument.body).getByRole("button", {
    name: "[2]",
  });
  citation.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
    }),
  );
  citation.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail: 1,
      shiftKey: true,
    }),
  );
  await waitFor(() => {
    expect(
      runtimeMessages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "kind" in message &&
          message.kind === "Citation",
      ),
      "citation disposition protocol lost deliberate Fork",
    ).toEqual([
      { channel: CHANNEL, disposition: "Follow", kind: "Citation", ordinal: 2 },
      { channel: CHANNEL, disposition: "Fork", kind: "Citation", ordinal: 2 },
    ]);
  });
  window.removeEventListener("message", captureRuntimeMessage);
  runtimeFrame.remove();

  const delivered: Array<{ ordinal: number; disposition: "Follow" | "Fork" }> = [];
  render(
    <DossierDocumentFrame
      title="Citation disposition"
      revisionRef="artifact_revision:revision-1"
      contentHtml="<article><p>Evidence.</p></article>"
      onCitation={(ordinal, disposition) => {
        delivered.push({ ordinal, disposition: disposition.kind });
      }}
      onFindCapabilityChange={() => undefined}
      onFindRequested={() => undefined}
    />,
  );
  const productFrame = screen.getByTitle(
    "Learning dossier: Citation disposition",
  ) as HTMLIFrameElement;
  const productChannel =
    productFrame
      .getAttribute("srcdoc")
      ?.match(/data-nexus-channel="([a-f0-9]{32})"/)?.[1] ?? "";

  for (const message of runtimeMessages) {
    if (
      typeof message !== "object" ||
      message === null ||
      !("kind" in message) ||
      message.kind !== "Citation"
    ) {
      continue;
    }
    fireEvent(
      window,
      new MessageEvent("message", {
        source: productFrame.contentWindow,
        data: { ...message, channel: productChannel },
      }),
    );
  }

  expect(
    delivered,
    "document frame did not preserve the runtime citation disposition",
  ).toEqual([
    { ordinal: 2, disposition: "Follow" },
    { ordinal: 2, disposition: "Fork" },
  ]);
});

it("seals the document in night dress inside the Solar even when the system prefers light", () => {
  document.documentElement.dataset.theme = "elvish";
  // The OS preference is the boundary under test: without the elvish→dark
  // mapping the frame falls through to prefers-color-scheme, so a
  // light-preferring system is the environment where the defect exists.
  const systemMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) =>
    query === "(prefers-color-scheme: light)"
      ? ({
          matches: true,
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        } as unknown as MediaQueryList)
      : systemMatchMedia.call(window, query)) as typeof window.matchMedia;
  try {
    render(
      <DossierDocumentFrame
        title="Solar dossier"
        revisionRef="artifact_revision:revision-1"
        contentHtml="<article><p>Evidence.</p></article>"
        onCitation={() => undefined}
        onFindCapabilityChange={() => undefined}
        onFindRequested={() => undefined}
      />,
    );
    const frame = screen.getByTitle(
      "Learning dossier: Solar dossier",
    ) as HTMLIFrameElement;
    expect(
      frame.getAttribute("srcdoc"),
      "the Solar must not open a white document",
    ).toContain('class="theme-dark"');
  } finally {
    window.matchMedia = systemMatchMedia;
  }
});
