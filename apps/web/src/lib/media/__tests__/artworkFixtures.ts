import { commands } from "vitest/browser";

// The retained, controller-manifested image bytes are decoded by the actual
// artwork owner. This declaration describes only the external fixture envelope.
export const artworkFixture: {
  readonly version: number;
  readonly source: string;
  readonly cases: readonly {
    readonly name: string;
    readonly type: string;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
    readonly sha256: string;
    readonly base64: string;
  }[];
} = JSON.parse(await commands.readFile("../../testdata/capacity/artwork.json"));
