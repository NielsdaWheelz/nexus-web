import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchCallsForPath,
  jsonResponse,
  stubFetch,
} from "@/__tests__/helpers/fetch";
import {
  dismissSynapseEdge,
  fetchSynapseScanStatus,
  requestSynapseScan,
} from "./synapse";

const MEDIA_REF = "media:11111111-1111-4111-8111-111111111111";

describe("synapse client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests a scan with the ref in the POST body", async () => {
    const fetchSpy = stubFetch(async () =>
      jsonResponse({ data: { queued: true, status: "pending" } }, 202),
    );

    await expect(requestSynapseScan(MEDIA_REF)).resolves.toEqual({
      queued: true,
      status: "pending",
    });

    const [call] = fetchCallsForPath(fetchSpy, "/api/synapse/scans");
    expect(call[1]?.method).toBe("POST");
    expect(JSON.parse(String(call[1]?.body))).toEqual({ ref: MEDIA_REF });
  });

  it("reads scan status from the ref-keyed query", async () => {
    const fetchSpy = stubFetch(async () =>
      jsonResponse({ data: { status: "running" } }),
    );

    await expect(fetchSynapseScanStatus(MEDIA_REF)).resolves.toBe("running");

    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/synapse/scans?ref=${encodeURIComponent(MEDIA_REF)}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("dismisses an edge via POST and tolerates the empty 204", async () => {
    const fetchSpy = stubFetch(async () => new Response(null, { status: 204 }));

    await expect(dismissSynapseEdge("edge-1")).resolves.toBeUndefined();

    const [call] = fetchCallsForPath(
      fetchSpy,
      "/api/synapse/edges/edge-1/dismiss",
    );
    expect(call[1]?.method).toBe("POST");
  });
});
