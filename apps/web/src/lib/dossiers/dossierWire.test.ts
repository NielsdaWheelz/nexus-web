import { describe, expect, it } from "vitest";
import {
  decodeDossierHead,
  decodeDossierRevision,
} from "@/lib/dossiers/dossierWire";

const absent = { kind: "Absent" };

function revisionWire(inputManifest: Record<string, unknown>) {
  return {
    artifact_id: "artifact-1",
    artifact_ref: "artifact:artifact-1",
    revision_id: "revision-1",
    revision_ref: "artifact_revision:revision-1",
    is_current: true,
    content_html:
      '<article><section id="overview"><h2>Dossier</h2></section></article>',
    content_text: "Dossier",
    citations: [],
    input_manifest: inputManifest,
    instruction: absent,
    creator_user_id: { kind: "Present", value: "user-1" },
    model_provider: { kind: "Present", value: "openai" },
    model_name: { kind: "Present", value: "gpt-5" },
    total_tokens: { kind: "Present", value: 1234 },
    created_at: "2026-07-23T12:00:00Z",
    promoted_at: absent,
  };
}

describe("dossierWire", () => {
  it("normalizes nested citation activations from the REST transport", () => {
    const decoded = decodeDossierRevision({
      ...revisionWire({
        version: "v1",
        kind: "page",
        page_ref: "page:p1",
        input_fingerprint: "fp",
        block_refs: [],
        connection_refs: [],
      }),
      citations: [
        {
          ordinal: 1,
          role: "supports",
          target_ref: { type: "media", id: "m1" },
          activation: {
            resource_ref: "media:m1",
            kind: "route",
            href: "/media/m1",
            unresolved_reason: null,
          },
          media_id: "m1",
          locator: null,
          deep_link: "/media/m1",
          snapshot: null,
        },
      ],
    });

    expect(decoded.citations[0]?.activation).toEqual({
      resourceRef: "media:m1",
      kind: "route",
      href: "/media/m1",
      unresolvedReason: null,
    });
  });

  it.each([
    [
      "media",
      {
        version: "v1",
        kind: "media",
        media_ref: "media:m1",
        content_fingerprint: "fp",
        offered_claim_count: 2,
        omitted_evidence: [{ evidence_ref: "evidence_span:e1" }],
      },
      {
        version: "v1",
        kind: "media",
        mediaRef: "media:m1",
        contentFingerprint: "fp",
        offeredClaimCount: 2,
        omittedEvidenceRefs: ["evidence_span:e1"],
      },
    ],
    [
      "conversation",
      {
        version: "v1",
        kind: "conversation",
        conversation_ref: "conversation:c1",
        message_refs: ["message:m1"],
        context_refs: ["media:m1"],
        topology_fingerprint: { kind: "Present", value: "topology" },
        completeness: { kind: "Complete" },
      },
      {
        version: "v1",
        kind: "conversation",
        conversationRef: "conversation:c1",
        messageRefs: ["message:m1"],
        contextRefs: ["media:m1"],
        topologyFingerprint: { kind: "Present", value: "topology" },
        completeness: { kind: "Complete" },
      },
    ],
    [
      "library",
      {
        version: "v1",
        kind: "library",
        library_ref: "library:l1",
        media: [
          {
            media_ref: "media:m1",
            content_fingerprint: "fp",
            disposition: "Included",
          },
        ],
      },
      {
        version: "v1",
        kind: "library",
        libraryRef: "library:l1",
        media: [
          {
            mediaRef: "media:m1",
            contentFingerprint: "fp",
            disposition: "Included",
          },
        ],
      },
    ],
    [
      "podcast",
      {
        version: "v1",
        kind: "podcast",
        podcast_ref: "podcast:p1",
        episodes: [],
      },
      {
        version: "v1",
        kind: "podcast",
        podcastRef: "podcast:p1",
        episodes: [],
      },
    ],
    [
      "contributor",
      {
        version: "v1",
        kind: "contributor",
        contributor_handle: "ursula-k-le-guin",
        works: [],
      },
      {
        version: "v1",
        kind: "contributor",
        contributorHandle: "ursula-k-le-guin",
        works: [],
      },
    ],
    [
      "page",
      {
        version: "v1",
        kind: "page",
        page_ref: "page:p1",
        input_fingerprint: "input-fp",
        block_refs: ["note_block:n1"],
        connection_refs: ["media:m1"],
      },
      {
        version: "v1",
        kind: "page",
        pageRef: "page:p1",
        inputFingerprint: "input-fp",
        blockRefs: ["note_block:n1"],
        connectionRefs: ["media:m1"],
      },
    ],
    [
      "note",
      {
        version: "v1",
        kind: "note",
        note_ref: "note_block:n1",
        input_fingerprint: "input-fp",
        body_fingerprint: { kind: "Present", value: "body-fp" },
        connection_refs: ["page:p1"],
      },
      {
        version: "v1",
        kind: "note",
        noteRef: "note_block:n1",
        inputFingerprint: "input-fp",
        bodyFingerprint: { kind: "Present", value: "body-fp" },
        connectionRefs: ["page:p1"],
      },
    ],
    [
      "idea",
      {
        version: "v1",
        kind: "idea",
        included_seed_refs: ["highlight:h1"],
        nexus_query_fingerprints: ["nexus-fp"],
        web_query_fingerprints: ["web-fp"],
        included_sources: [
          {
            ref: "media:m1",
            content_fingerprint: "source-fp",
            role: "nexus",
          },
        ],
        omitted_sources: [
          { locator: "https://example.test", reason: "Unreadable" },
        ],
      },
      {
        version: "v1",
        kind: "idea",
        includedSeedRefs: ["highlight:h1"],
        nexusQueryFingerprints: ["nexus-fp"],
        webQueryFingerprints: ["web-fp"],
        includedSources: [
          {
            ref: "media:m1",
            contentFingerprint: "source-fp",
            role: "nexus",
          },
        ],
        omittedSources: [
          { locator: "https://example.test", reason: "Unreadable" },
        ],
      },
    ],
  ])("decodes the closed %s manifest", (_kind, wire, expected) => {
    expect(decodeDossierRevision(revisionWire(wire)).inputManifest).toEqual(
      expected,
    );
  });

  it("rejects an unknown Idea source role", () => {
    expect(() =>
      decodeDossierRevision(
        revisionWire({
          version: "v1",
          kind: "idea",
            included_seed_refs: [],
          nexus_query_fingerprints: [],
          web_query_fingerprints: [],
          included_sources: [
            {
              ref: "media:m1",
              content_fingerprint: "source-fp",
              role: "principal",
            },
          ],
          omitted_sources: [],
        }),
      ),
    ).toThrow("unknown included_sources.role");
  });

  it("decodes visible revision provenance and rejects unknown manifest kinds", () => {
    const decoded = decodeDossierRevision(
      revisionWire({
        version: "v1",
        kind: "media",
        media_ref: "media:m1",
        content_fingerprint: "fp",
        offered_claim_count: 0,
        omitted_evidence: [],
      }),
    );
    expect(decoded).toMatchObject({
      contentHtml:
        '<article><section id="overview"><h2>Dossier</h2></section></article>',
      contentText: "Dossier",
      creatorUserId: { kind: "Present", value: "user-1" },
      modelProvider: { kind: "Present", value: "openai" },
      modelName: { kind: "Present", value: "gpt-5" },
      totalTokens: { kind: "Present", value: 1234 },
    });
    expect(() =>
      decodeDossierRevision(revisionWire({ version: "v1", kind: "unknown" })),
    ).toThrow(/unknown input_manifest kind/);
  });

  it("decodes the public Idea identity without exposing its private key", () => {
    const decoded = decodeDossierHead({
      artifact_id: { kind: "Present", value: "artifact-1" },
      artifact_ref: { kind: "Present", value: "artifact:artifact-1" },
      current_revision: absent,
      freshness: absent,
      active_build: absent,
      latest_unsuccessful_build: absent,
      revision_count: 0,
      media_abstract: absent,
      identity: {
        kind: "Present",
        value: { kind: "Idea", title: "Bayesian inference" },
      },
    });

    expect(decoded.identity).toEqual({
      kind: "Present",
      value: { kind: "Idea", title: "Bayesian inference" },
    });
  });
});
