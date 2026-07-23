import { describe, expect, it } from "vitest";
import { absent, present } from "@/lib/api/presence";
import type { DossierInputManifest } from "@/lib/dossiers/dossierControllerTypes";
import { dossierCoverageLabel } from "./dossierCoverage";

describe("dossierCoverageLabel", () => {
  it.each<[DossierInputManifest, string]>([
    [
      {
        version: "v1",
        kind: "media",
        mediaRef: "media:m1",
        contentFingerprint: "f1",
        offeredClaimCount: 7,
        omittedEvidenceRefs: ["evidence_span:e1"],
      },
      "7 claims offered · 1 evidence item omitted",
    ],
    [
      {
        version: "v1",
        kind: "conversation",
        conversationRef: "conversation:c1",
        messageRefs: ["message:m1", "message:m2"],
        contextRefs: ["media:m1"],
        topologyFingerprint: present("t1"),
        completeness: { kind: "Complete" },
      },
      "2 messages · 1 context item · complete",
    ],
    [
      {
        version: "v1",
        kind: "library",
        libraryRef: "library:l1",
        media: [
          {
            mediaRef: "media:m1",
            contentFingerprint: "f1",
            disposition: "Included",
          },
          {
            mediaRef: "media:m2",
            contentFingerprint: "f2",
            disposition: "OmittedBudget",
          },
        ],
      },
      "2 media items · 1 included · 1 omitted",
    ],
    [
      {
        version: "v1",
        kind: "podcast",
        podcastRef: "podcast:p1",
        episodes: [],
      },
      "0 episodes · 0 included · 0 omitted",
    ],
    [
      {
        version: "v1",
        kind: "contributor",
        contributorHandle: "author",
        works: [],
      },
      "0 works · 0 included · 0 omitted",
    ],
    [
      {
        version: "v1",
        kind: "page",
        pageRef: "page:p1",
        inputFingerprint: "f1",
        blockRefs: ["note_block:n1"],
        connectionRefs: ["media:m1"],
      },
      "1 block · 1 connection",
    ],
    [
      {
        version: "v1",
        kind: "note",
        noteRef: "note_block:n1",
        inputFingerprint: "f1",
        bodyFingerprint: absent(),
        connectionRefs: [],
      },
      "body unavailable · 0 connections",
    ],
  ])("renders the closed manifest union", (manifest, expected) => {
    expect(dossierCoverageLabel(manifest)).toBe(expected);
  });
});
