// phase 0 (track c) temporary red/green harness: the extracted contract modules
// exist, import only what the extension bundle may carry, decode the frozen wire
// shapes, own their names alone, and the capture contract equals freeze §8.
// run: bun test tools/firefox-harness/phase0-contracts.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const web = join(root, "apps", "web", "src");
const read = (relative: string): string =>
  readFileSync(join(web, relative), "utf8");

const importSpecifiers = (source: string): string[] =>
  [...source.matchAll(/import[^;]*?from\s+"([^"]+)"/g)].map((m) => m[1]!);

const hasReexport = (source: string): boolean =>
  /export\s+(type\s+)?(\{[^}]*\}|\*)\s+from\s+"/.test(source);

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });

describe("lib/media/uploadSessionContract.ts", () => {
  const path = "lib/media/uploadSessionContract.ts";

  test("carries only validation and the verification vocabulary", () => {
    const source = read(path);
    expect(source.startsWith('"use client"')).toBe(false);
    expect(new Set(importSpecifiers(source))).toEqual(
      new Set(["@/lib/validation", "@/lib/media/uploadVerification"]),
    );
    expect(hasReexport(source)).toBe(false);
  });

  test("exports exactly the frozen runtime names", async () => {
    const module = await import(join(web, path));
    expect(Object.keys(module).sort()).toEqual(
      ["UPLOAD_IDEMPOTENCY_OUTCOMES", "decodeUploadResponse"].sort(),
    );
    expect(module.UPLOAD_IDEMPOTENCY_OUTCOMES).toEqual(["Created", "Reused"]);
  });

  test("decodes the three enveloped variants", async () => {
    const { decodeUploadResponse } = await import(join(web, path));
    expect(
      decodeUploadResponse({
        data: {
          kind: "UploadRequired",
          session_handle: "nup1.aaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb",
          generation: 2,
          method: "PUT",
          upload_url: "http://127.0.0.1:9000/nexus/uploads/x?X-Amz-Signature=s",
          required_headers: { "Content-Type": "application/pdf" },
          expires_at: "2026-09-23T10:00:00Z",
          idempotency_outcome: "Created",
        },
      }),
    ).toEqual({
      kind: "UploadRequired",
      sessionHandle: "nup1.aaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb",
      generation: 2,
      method: "PUT",
      uploadUrl: "http://127.0.0.1:9000/nexus/uploads/x?X-Amz-Signature=s",
      requiredHeaders: { "Content-Type": "application/pdf" },
      expiresAt: "2026-09-23T10:00:00Z",
    });
    expect(
      decodeUploadResponse({
        data: {
          kind: "Published",
          session_handle: "nup1.a.b",
          media_id: "0199a000-0000-7000-8000-000000000001",
          source_attempt_id: "0199a000-0000-7000-8000-000000000002",
          idempotency_outcome: "Reused",
        },
      }),
    ).toEqual({
      kind: "Published",
      sessionHandle: "nup1.a.b",
      mediaId: "0199a000-0000-7000-8000-000000000001",
      sourceAttemptId: "0199a000-0000-7000-8000-000000000002",
      idempotencyOutcome: "Reused",
    });
    expect(
      decodeUploadResponse({
        data: {
          kind: "NeedsAttention",
          session_handle: "nup1.a.b",
          failure: { kind: "CapabilityExpired", expired_at: "2026-09-23T10:00:00Z" },
          capabilities: { can_retry_upload: true, can_remove: false },
        },
      }),
    ).toEqual({
      kind: "NeedsAttention",
      sessionHandle: "nup1.a.b",
      failure: { kind: "CapabilityExpired", expiredAt: "2026-09-23T10:00:00Z" },
      capabilities: { canRetryUpload: true, canRemove: false },
    });
  });

  test("rejects a capability that could smuggle credentials or a dead generation", async () => {
    const { decodeUploadResponse } = await import(join(web, path));
    const capability = {
      kind: "UploadRequired",
      session_handle: "nup1.a.b",
      generation: 1,
      method: "PUT",
      upload_url: "http://127.0.0.1:9000/x",
      required_headers: { "Content-Type": "application/pdf" },
      expires_at: "2026-09-23T10:00:00Z",
      idempotency_outcome: "Created",
    };
    expect(() =>
      decodeUploadResponse({
        data: {
          ...capability,
          required_headers: {
            "Content-Type": "application/pdf",
            Authorization: "Bearer nexus",
          },
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      decodeUploadResponse({ data: { ...capability, generation: 0 } }),
    ).toThrow(TypeError);
    expect(() =>
      decodeUploadResponse({ data: capability, request_id: "r" }),
    ).toThrow(TypeError);
    expect(() => decodeUploadResponse(capability)).toThrow(TypeError);
  });
});

describe("lib/libraries/destinationContract.ts", () => {
  const path = "lib/libraries/destinationContract.ts";

  test("carries only validation", () => {
    const source = read(path);
    expect(source.startsWith('"use client"')).toBe(false);
    expect(new Set(importSpecifiers(source))).toEqual(
      new Set(["@/lib/validation"]),
    );
    expect(hasReexport(source)).toBe(false);
  });

  test("exports exactly the frozen runtime names", async () => {
    const module = await import(join(web, path));
    expect(Object.keys(module).sort()).toEqual(
      ["LibraryDestinationContractDefect", "decodeLibraryDestinationSelection", "decodeWritableLibraryDestinationPage"].sort(),
    );
  });

  test("decodes a page and defects on a disagreeing cursor", async () => {
    const { LibraryDestinationContractDefect, decodeWritableLibraryDestinationPage } =
      await import(join(web, path));
    const destination = {
      id: "0199a000-0000-7000-8000-000000000003",
      name: "Reading group",
      created_at: "2026-09-23T10:00:00Z",
      updated_at: "2026-09-23T10:00:00Z",
    };
    expect(
      decodeWritableLibraryDestinationPage({
        data: [destination],
        page: { has_more: true, next_cursor: "c1" },
      }),
    ).toEqual({
      data: [destination],
      page: { has_more: true, next_cursor: "c1" },
    });
    expect(() =>
      decodeWritableLibraryDestinationPage({
        data: [destination],
        page: { has_more: true, next_cursor: null },
      }),
    ).toThrow(LibraryDestinationContractDefect);
    expect(() =>
      decodeWritableLibraryDestinationPage({
        data: [{ ...destination, name: "" }],
        page: { has_more: false, next_cursor: null },
      }),
    ).toThrow(LibraryDestinationContractDefect);
  });
});

describe("extension/captureContract.ts", () => {
  const path = "extension/captureContract.ts";

  test("contains freeze §8 verbatim", () => {
    const freeze = readFileSync(
      join(root, "docs", "extension-firefox-v1-freeze.md"),
      "utf8",
    );
    const section = freeze.slice(freeze.indexOf("\n## 8. "));
    const block = section.slice(
      section.indexOf("```ts\n") + "```ts\n".length,
      section.indexOf("\n```\n"),
    );
    // the file adds runtime imports above the types; the typed contract itself
    // starts at the first exported type and must appear verbatim.
    const types = block.slice(block.indexOf("export type CaptureTargetView"));
    expect(read(path).includes(types)).toBe(true);
  });
});

describe("single ownership", () => {
  test("ingestionClient.ts no longer declares the moved names and decodes through the contract", () => {
    const source = read("lib/media/ingestionClient.ts");
    for (const declaration of [
      "type UploadResponse =",
      "type UploadCapability =",
      "type PublishedUpload =",
      "type UploadFailure =",
      "UPLOAD_IDEMPOTENCY_OUTCOMES =",
      "function uploadFailure(",
      "function browserSettableHeaders(",
      "function uploadResponse(",
    ]) {
      expect(source).not.toContain(declaration);
    }
    expect(source).toContain("function retryResponse(");
    expect(source).toContain("function confirmedUpload(");
    expect(importSpecifiers(source)).toContain(
      "@/lib/media/uploadSessionContract",
    );
    expect(hasReexport(source)).toBe(false);
  });

  test("client.ts no longer declares the moved names and keeps the defect predicate", () => {
    const source = read("lib/libraries/client.ts");
    for (const declaration of [
      "interface LibraryDestination ",
      "type LibraryDestinationSelection =",
      "interface LibraryDestinationPage ",
      "class LibraryDestinationContractDefect",
      "function decodeWritableLibraryDestinationPage(",
      "function decodeLibraryDestination(",
      "function invalidDestinationResponse(",
    ]) {
      expect(source).not.toContain(declaration);
    }
    expect(source).toContain("export function isLibraryDestinationDefect(");
    expect(importSpecifiers(source)).toContain(
      "@/lib/libraries/destinationContract",
    );
    expect(hasReexport(source)).toBe(false);
  });

  test("no importer reads a moved destination name from client.ts", () => {
    const moved =
      /\b(LibraryDestination|LibraryDestinationSelection|LibraryDestinationPage|LibraryDestinationContractDefect|decodeWritableLibraryDestinationPage)\b/;
    for (const file of sourceFiles(web)) {
      const source = readFileSync(file, "utf8");
      for (const statement of source.matchAll(
        /import[^;]*?from\s+"@\/lib\/libraries\/client"/g,
      )) {
        expect(`${file}: ${statement[0]}`).not.toMatch(moved);
      }
    }
  });
});
