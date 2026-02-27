import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PdfReader, { type PdfReaderDeps } from "@/components/PdfReader";

function createFakePage() {
  return {
    getViewport: vi.fn(() => ({ width: 800, height: 1100 })),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
  };
}

function createFakeDocument(numPages: number) {
  return {
    numPages,
    getPage: vi.fn(async (pageNumber: number) => {
      void pageNumber;
      return createFakePage();
    }),
    destroy: vi.fn(async () => undefined),
  };
}

function createDeps(options: {
  urls: string[];
  docsByUrl: Record<string, ReturnType<typeof createFakeDocument>>;
}): {
  deps: PdfReaderDeps;
  apiFetchMock: ReturnType<typeof vi.fn>;
  getDocumentMock: ReturnType<typeof vi.fn>;
} {
  const apiFetchMock = vi
    .fn()
    .mockImplementationOnce(async () => ({
      data: {
        url: options.urls[0],
        expires_at: "2030-01-01T00:00:00Z",
      },
    }))
    .mockImplementationOnce(async () => ({
      data: {
        url: options.urls[1] ?? options.urls[0],
        expires_at: "2030-01-01T00:00:00Z",
      },
    }));

  const getDocumentMock = vi.fn((source: { url: string }) => {
    const doc = options.docsByUrl[source.url];
    if (!doc) {
      return { promise: Promise.reject(new Error(`Unknown URL: ${source.url}`)) };
    }
    return { promise: Promise.resolve(doc) };
  });

  const deps: PdfReaderDeps = {
    apiFetch: apiFetchMock,
    loadPdfJs: async () => ({
      getDocument: getDocumentMock,
      GlobalWorkerOptions: { workerSrc: "" },
    }),
    workerSrc: "/pdf.worker.test.mjs",
  };

  return { deps, apiFetchMock, getDocumentMock };
}

describe("PdfReader", () => {
  it("loads via canonical file endpoint and renders canvas viewer without iframe", async () => {
    const url = "https://storage.example/signed-1";
    const doc = createFakeDocument(3);
    const { deps, apiFetchMock, getDocumentMock } = createDeps({
      urls: [url],
      docsByUrl: { [url]: doc },
    });

    render(<PdfReader mediaId="media-1" deps={deps} />);

    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledWith("/api/media/media-1/file");
    expect(getDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ url })
    );
    expect(screen.getByRole("img", { name: "PDF page" })).toBeInTheDocument();
  });

  it("refreshes signed URL and recovers when page load fails with expiry error", async () => {
    const signedUrl1 = "https://storage.example/signed-1";
    const signedUrl2 = "https://storage.example/signed-2";

    const firstDoc = createFakeDocument(2);
    firstDoc.getPage.mockImplementation(async (pageNumber: number) => {
      if (pageNumber === 1) {
        return createFakePage();
      }
      const err = new Error("Unexpected server response (403) while loading PDF page");
      (err as { status?: number }).status = 403;
      throw err;
    });

    const secondDoc = createFakeDocument(2);

    const { deps, apiFetchMock, getDocumentMock } = createDeps({
      urls: [signedUrl1, signedUrl2],
      docsByUrl: {
        [signedUrl1]: firstDoc,
        [signedUrl2]: secondDoc,
      },
    });

    render(<PdfReader mediaId="media-2" deps={deps} />);

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /next page/i }));

    expect(await screen.findByText("Page 2 of 2")).toBeInTheDocument();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(getDocumentMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ url: signedUrl1 })
    );
    expect(getDocumentMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ url: signedUrl2 })
    );
  });

  it("shows deterministic non-success state for password-protected PDFs", async () => {
    const signedUrl = "https://storage.example/signed-password";
    const passwordError = new Error("Password required");
    passwordError.name = "PasswordException";

    const { deps } = createDeps({
      urls: [signedUrl],
      docsByUrl: {},
    });

    const loadPdfJs = async () => ({
      getDocument: vi.fn(() => ({ promise: Promise.reject(passwordError) })),
      GlobalWorkerOptions: { workerSrc: "" },
    });

    render(<PdfReader mediaId="media-3" deps={{ ...deps, loadPdfJs }} />);

    expect(
      await screen.findByText(/password-protected and cannot be opened/i)
    ).toBeInTheDocument();
  });
});
