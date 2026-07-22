import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConnectionEndpointOut } from "@/lib/resourceGraph/connections";
import ConnectionRail from "./ConnectionRail";

const PEER_ID = "11111111-1111-4111-8111-111111111111";

const connectedPeer: ConnectionEndpointOut = {
  ref: `media:${PEER_ID}`,
  scheme: "media",
  id: PEER_ID,
  label: "Connected document",
  description: "Graph-owned metadata",
  activation: {
    resourceRef: `media:${PEER_ID}`,
    kind: "route",
    href: `/media/${PEER_ID}`,
    unresolvedReason: null,
  },
  href: `/media/${PEER_ID}`,
  missing: false,
};

describe("ConnectionRail", () => {
  it("renders graph and Related overlap once with graph metadata winning", () => {
    render(
      <ConnectionRail
        peers={[connectedPeer]}
        related={[{ ...connectedPeer, label: "Duplicate related label" }]}
        relatedStatus="ready"
      />,
    );

    expect(
      screen.getAllByRole("link", { name: "Connected document" }),
    ).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Connected document" })).toHaveAttribute(
      "href",
      `/media/${PEER_ID}`,
    );
    expect(screen.queryByText("Duplicate related label")).not.toBeInTheDocument();
  });
});
