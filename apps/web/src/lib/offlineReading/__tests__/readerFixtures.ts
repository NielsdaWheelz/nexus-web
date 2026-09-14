import { commands } from "vitest/browser";

// These are the controller-manifested producer artifacts. Product decoders still
// decide whether their member bytes satisfy the reader protocol.
interface FixtureMetadata {
  readonly manifest: {
    readonly mediaId: string;
    readonly title: string;
    readonly readerGeneration: number;
    readonly readerRevisionKey: string;
    readonly entries: readonly {
      readonly path: string;
      readonly mediaType: string;
      readonly sizeBytes: number;
      readonly sha256: string;
    }[];
  };
}
interface FixtureMembers {
  readonly members: Readonly<Record<string, string>>;
}

export const unicodeMetadata: FixtureMetadata & {
  readonly fragment_id: string;
} = JSON.parse(
  await commands.readFile(
    "../../testdata/offline-reading/retained-unicode-schema-2.json",
  ),
);
export const unicodeMembers: FixtureMembers = JSON.parse(
  await commands.readFile(
    "../../testdata/offline-reading/retained-unicode-schema-2-members.json",
  ),
);
export const epubMetadata: FixtureMetadata = JSON.parse(
  await commands.readFile(
    "../../testdata/offline-reading/retained-epub-schema-2.json",
  ),
);
export const epubMembers: FixtureMembers = JSON.parse(
  await commands.readFile(
    "../../testdata/offline-reading/retained-epub-schema-2-members.json",
  ),
);
export const pdfMetadata: FixtureMetadata = JSON.parse(
  await commands.readFile(
    "../../testdata/offline-reading/retained-pdf-schema-2.json",
  ),
);
export const pdfMembers: FixtureMembers = JSON.parse(
  await commands.readFile(
    "../../testdata/offline-reading/retained-pdf-schema-2-members.json",
  ),
);
