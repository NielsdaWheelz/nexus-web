import { describe, expect, it } from "vitest";
import { POST } from "./route";
import {
  createProvenancePacket,
  type ProvenanceModel,
} from "@/lib/conversations/provenance";

const emptyModel: ProvenanceModel = {
  messageCount: 0,
  assistantCount: 0,
  claimCount: 0,
  supportedClaimCount: 0,
  riskClaimCount: 0,
  retrievalCount: 0,
  includedRetrievalCount: 0,
  sourceCount: 0,
  artifactCount: 0,
  artifactPartCount: 0,
  citedArtifactPartCount: 0,
  memoryItemCount: 0,
  memorySourceCount: 0,
  citationIssueCount: 0,
  sources: [],
  riskClaims: [],
  artifacts: [],
};

describe("POST /api/provenance/verify", () => {
  it("verifies a canonical packet wrapper", async () => {
    const packet = createProvenancePacket(emptyModel);

    const response = await POST(
      new Request("http://localhost:3000/api/provenance/verify", {
        method: "POST",
        body: JSON.stringify({ packet }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        ok: true,
        actualFingerprint: packet.fingerprint,
        expectedFingerprint: packet.fingerprint,
        issues: [],
      },
    });
  });

  it("rejects tampered packets with diagnostics", async () => {
    const packet = createProvenancePacket(emptyModel);
    const tampered = {
      ...packet,
      counts: {
        ...packet.counts,
        sourceCount: 1,
      },
    };

    const response = await POST(
      new Request("http://localhost:3000/api/provenance/verify", {
        method: "POST",
        body: JSON.stringify(tampered),
      }),
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.data.ok).toBe(false);
    expect(body.data.actualFingerprint).toBe(packet.fingerprint);
    expect(body.data.expectedFingerprint).not.toBe(packet.fingerprint);
    expect(body.data.issues).toContainEqual(
      expect.objectContaining({ id: "packet-fingerprint" }),
    );
    expect(body.data.issues).toContainEqual(
      expect.objectContaining({ id: "packet-source-count" }),
    );
  });

  it("returns a structured error for invalid JSON", async () => {
    const response = await POST(
      new Request("http://localhost:3000/api/provenance/verify", {
        method: "POST",
        body: "{not-json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "E_INVALID_JSON",
        message: "Request body must be valid JSON.",
      },
    });
  });
});
