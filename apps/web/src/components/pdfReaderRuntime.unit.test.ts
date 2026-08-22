import { describe, expect, it } from "vitest";

describe("PDF.js owned runtime closure", () => {
  it("pins worker, CMap, standard font, and WASM directories under the hosted asset root", async () => {
    const runtime = await import("./pdfReaderRuntime");
    expect({
      worker: runtime.PDF_WORKER_SRC,
      cmap: runtime.PDF_CMAP_URL,
      fonts: runtime.PDF_STANDARD_FONT_URL,
      wasm: runtime.PDF_WASM_URL,
    }).toEqual({
      worker: "/pdfjs/pdf.worker.min.mjs",
      cmap: "/pdfjs/cmaps/",
      fonts: "/pdfjs/standard_fonts/",
      wasm: "/pdfjs/wasm/",
    });
  });

  it("pins every runtime member under an environment-injected root without host sniffing", async () => {
    const runtime = await import("./pdfReaderRuntime");
    const injectedRoot = "/nexus-offline/pdfjs";

    expect([
      runtime.pdfRuntimePath("pdf.worker.min.mjs", injectedRoot),
      runtime.pdfRuntimePath("cmaps/", injectedRoot),
      runtime.pdfRuntimePath("standard_fonts/", injectedRoot),
      runtime.pdfRuntimePath("wasm/", injectedRoot),
    ]).toEqual([
      "/nexus-offline/pdfjs/pdf.worker.min.mjs",
      "/nexus-offline/pdfjs/cmaps/",
      "/nexus-offline/pdfjs/standard_fonts/",
      "/nexus-offline/pdfjs/wasm/",
    ]);
  });

  it("keeps the offline shell's injected runtime root inside its served base", async () => {
    const config = (await import("../../vite.offline-reading.config")).default;
    const define = config.define ?? {};
    const injected = define.__NEXUS_PDF_RUNTIME_ROOT__;
    expect(injected).toBe(JSON.stringify("/nexus-offline/pdfjs"));
    expect(
      (JSON.parse(injected as string) as string).startsWith(
        String(config.base).replace(/\/$/, ""),
      ),
    ).toBe(true);
  });
});
