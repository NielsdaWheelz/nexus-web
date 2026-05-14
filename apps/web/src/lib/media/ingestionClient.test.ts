import { describe, expect, it } from "vitest";
import { getFileUploadError } from "./ingestionClient";

describe("getFileUploadError", () => {
  it("accepts PDF and EPUB files inside the upload limits", () => {
    expect(
      getFileUploadError(
        new File(["%PDF-1.7"], "paper.pdf", { type: "application/pdf" }),
      ),
    ).toBeNull();
    expect(
      getFileUploadError(
        new File(["PK\u0003\u0004"], "book.epub", {
          type: "application/epub+zip",
        }),
      ),
    ).toBeNull();
  });

  it("rejects unsupported files before upload initialization", () => {
    expect(
      getFileUploadError(
        new File(["hello"], "notes.txt", { type: "text/plain" }),
      ),
    ).toBe("Only PDF and EPUB files are supported.");
  });

  it("rejects files above the product upload caps", () => {
    const file = new File([""], "book.epub", { type: "application/epub+zip" });
    Object.defineProperty(file, "size", { value: 50 * 1024 * 1024 + 1 });

    expect(getFileUploadError(file)).toBe(
      "EPUB files must be 50 MB or smaller.",
    );
  });
});
