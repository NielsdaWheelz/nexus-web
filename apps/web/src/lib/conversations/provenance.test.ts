import { describe, expect, it } from "vitest";
import {
  assessProvenanceModel,
  buildProvenanceModel,
  countProvenanceSignals,
  createProvenancePacket,
  formatProvenanceBrief,
  stringifyProvenancePacket,
  verifyProvenancePacket,
} from "@/lib/conversations/provenance";
import type { ConversationMessage } from "@/lib/conversations/types";

const provenanceMessage = {
  id: "assistant-10",
  seq: 4,
  role: "assistant",
  status: "complete",
  error_code: null,
  can_retry_response: false,
  created_at: "2026-01-03T00:00:00Z",
  updated_at: "2026-01-03T00:00:00Z",
  message_document: {
    type: "message_document",
    version: 1,
    blocks: [
      {
        type: "text",
        format: "markdown",
        text: "Deep work needs deliberate recovery.",
      },
      {
        type: "retrieval_result",
        id: "retrieval-1",
        ordinal: 0,
        result_type: "content_chunk",
        source_id: "chunk-1",
        media_id: "media-1",
        evidence_span_id: "span-1",
        context_ref: {
          type: "content_chunk",
          id: "chunk-1",
        },
        result_ref: {
          type: "content_chunk",
          title: "Deep Work",
          snippet: "Recovery keeps attention sustainable.",
          deep_link: "/media/media-1",
        },
        deep_link: "/media/media-1",
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "fragment-1",
          start_offset: 0,
          end_offset: 38,
        },
        score: 0.92,
        selected: true,
        source_title: "Deep Work",
        exact_snippet: "Recovery keeps attention sustainable.",
        retrieval_status: "included_in_prompt",
        included_in_prompt: true,
        source_version: "source-v1",
      },
      {
        type: "claim",
        claim_id: "claim-1",
        ordinal: 0,
        claim_text: "Recovery keeps attention sustainable.",
        support_status: "not_enough_evidence",
        verifier_status: "llm_verified",
      },
      {
        type: "claim_evidence",
        id: "evidence-1",
        claim_id: "claim-1",
        ordinal: 0,
        evidence_role: "supports",
        source_ref: {
          type: "message_retrieval",
          id: "retrieval-1",
          label: "Deep Work",
          media_id: "media-1",
          deep_link: "/media/media-1",
        },
        exact_snippet: "Recovery keeps attention sustainable.",
        locator: {
          type: "web_text_offsets",
          media_id: "media-1",
          fragment_id: "fragment-1",
          start_offset: 0,
          end_offset: 38,
        },
        deep_link: "/media/media-1",
        citation_label: "Deep Work",
        score: 0.92,
        retrieval_status: "included_in_prompt",
        selected: true,
        included_in_prompt: true,
        source_version: "source-v1",
        created_at: "2026-01-03T00:00:00Z",
      },
      {
        type: "artifact_preview",
        durable_artifact_id: "artifact-1",
        artifact_key: "focus-study-guide",
        artifact_version: 1,
        artifact_kind: "study_guide",
        title: "Focus Study Guide",
        status: "complete",
        parts: [
          {
            id: "artifact-part-1",
            artifact_id: "artifact-1",
            ordinal: 0,
            part_key: "Practice loop",
            part_type: "section",
            text: "Use recovery blocks between focus sessions.",
            source_version: "source-v1",
            locator: {
              type: "web_text_offsets",
              media_id: "media-1",
              fragment_id: "fragment-1",
              start_offset: 0,
              end_offset: 38,
            },
            source_ref: {
              type: "message_retrieval",
              id: "retrieval-1",
              label: "Deep Work",
              media_id: "media-1",
              deep_link: "/media/media-1",
            },
            evidence_span_id: "span-1",
          },
        ],
      },
    ],
  },
} as ConversationMessage;

describe("conversation provenance", () => {
  it("builds a source-claim-artifact lineage model from message document blocks", () => {
    const model = buildProvenanceModel([provenanceMessage]);

    expect(model.assistantCount).toBe(1);
    expect(model.claimCount).toBe(1);
    expect(model.riskClaimCount).toBe(1);
    expect(model.retrievalCount).toBe(1);
    expect(model.includedRetrievalCount).toBe(1);
    expect(model.artifactCount).toBe(1);
    expect(model.artifactPartCount).toBe(1);
    expect(model.citedArtifactPartCount).toBe(1);
    expect(countProvenanceSignals([provenanceMessage])).toBe(3);

    const source = model.sources[0];
    expect(source).toMatchObject({
      key: "media:media-1",
      label: "Deep Work",
      href: "/media/media-1",
      sourceVersions: ["source-v1"],
      retrievalCount: 1,
      includedRetrievalCount: 1,
      claimEvidenceCount: 1,
      artifactPartCount: 1,
    });
    expect(source?.claims[0]).toMatchObject({
      id: "claim-1",
      status: "not_enough_evidence",
      text: "Recovery keeps attention sustainable.",
    });
    expect(source?.artifactParts[0]).toMatchObject({
      artifactTitle: "Focus Study Guide",
      partKey: "Practice loop",
      partType: "section",
    });
  });

  it("scores evidence risk and produces repair actions", () => {
    const audit = assessProvenanceModel(buildProvenanceModel([provenanceMessage]));

    expect(audit).toMatchObject({
      score: 82,
      level: "attention",
      label: "Needs evidence work",
    });
    expect(audit.coverage).toMatchObject({
      retrieval: 1,
      claims: 0,
      artifacts: 1,
    });
    expect(audit.issues[0]).toMatchObject({
      id: "claim-risk",
      severity: "attention",
      label: "1 claim needs review",
    });
    expect(audit.nextActions).toContain(
      "Re-run retrieval or rewrite the answer around evidence-backed claims.",
    );
  });

  it("formats a portable audit brief for the provenance graph", () => {
    const brief = formatProvenanceBrief(buildProvenanceModel([provenanceMessage]));

    expect(brief).toContain("Evidence audit brief");
    expect(brief).toContain("1 assistant turn, 1 source, 1 claim, 1 artifact.");
    expect(brief).toContain("Verdict: Needs evidence work (82/100).");
    expect(brief).toMatch(/Packet: pv_[0-9a-f]{8}/);
    expect(brief).toContain("- Retrieved in prompt: 1/1");
    expect(brief).toContain(
      "1 claim needs review: Needs evidence: Recovery keeps attention sustainable.",
    );
    expect(brief).toContain(
      "Re-run retrieval or rewrite the answer around evidence-backed claims.",
    );
    expect(brief).toContain(
      "- Deep Work: 1/1 retrieved, 1 claim links, 1 artifact parts",
    );
    expect(brief).toContain("- Focus Study Guide: 1/1 cited parts");
  });

  it("creates a deterministic machine-readable provenance packet", () => {
    const model = buildProvenanceModel([provenanceMessage]);
    const packet = createProvenancePacket(model);
    const packetAgain = createProvenancePacket(buildProvenanceModel([provenanceMessage]));
    const packetText = stringifyProvenancePacket(model);

    expect(packet.fingerprint).toMatch(/^pv_[0-9a-f]{8}$/);
    expect(packetAgain.fingerprint).toBe(packet.fingerprint);
    expect(packet.schema_version).toBe("nexus.provenance.packet.v1");
    expect(packet.audit).toMatchObject({
      score: 82,
      level: "attention",
      nextActions: [
        "Re-run retrieval or rewrite the answer around evidence-backed claims.",
      ],
    });
    expect(packet.sources[0]).toMatchObject({
      key: "media:media-1",
      source_versions: ["source-v1"],
      retrievals: {
        included: 1,
        total: 1,
      },
      claim_links: 1,
      artifact_parts: 1,
    });
    expect(packetText).toContain('"schema_version": "nexus.provenance.packet.v1"');
    expect(packetText).toContain(`"fingerprint": "${packet.fingerprint}"`);
  });

  it("verifies packet fingerprints and reports tampering", () => {
    const packet = createProvenancePacket(buildProvenanceModel([provenanceMessage]));
    const verification = verifyProvenancePacket(packet);

    expect(verification).toMatchObject({
      ok: true,
      actualFingerprint: packet.fingerprint,
      expectedFingerprint: packet.fingerprint,
      issues: [],
    });

    const tampered = structuredClone(packet);
    tampered.sources[0].source_versions = ["source-v2"];
    const tamperedVerification = verifyProvenancePacket(tampered);

    expect(tamperedVerification.ok).toBe(false);
    expect(tamperedVerification.actualFingerprint).toBe(packet.fingerprint);
    expect(tamperedVerification.expectedFingerprint).not.toBe(packet.fingerprint);
    expect(tamperedVerification.issues).toContainEqual(
      expect.objectContaining({
        id: "packet-fingerprint",
        severity: "attention",
      }),
    );
  });
});
