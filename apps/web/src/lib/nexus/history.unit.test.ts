import { expect, it } from "vitest";
import contract from "../../../../../testdata/contracts/nexus-history.json";
import { DESTINATIONS } from "@/lib/navigation/destinations";
import { MAX_PANES } from "@/lib/workspace/schema";
import { decodeNexusHistoryResponse, MAX_NEXUS_HISTORY_TARGETS, NEXUS_OWNED_CANDIDATE_LIMIT, nexusHistoryCommand, nexusHistoryLabel } from "./history";

it("fits the real client candidate union inside the shared history read contract", () => {
  expect(MAX_PANES).toBe(contract.sourceMaxima.panes);
  expect(DESTINATIONS.length).toBe(contract.sourceMaxima.destinations);
  expect(NEXUS_OWNED_CANDIDATE_LIMIT).toBe(contract.sourceMaxima.owned);
  expect(Object.values(contract.sourceMaxima).reduce((sum, count) => sum + count, 0)).toBe(MAX_NEXUS_HISTORY_TARGETS);
  expect(MAX_NEXUS_HISTORY_TARGETS).toBe(contract.maxTargets);
});

it("sends every destination the shared target grammar accepts as scoreable history", () => {
  // The server's grammar owns which hrefs have history; this fixture is the one
  // cross-language statement of it, asserted again in test_nexus_history.py.
  expect([...DESTINATIONS.map((destination) => destination.href)].sort()).toEqual(
    [...contract.destinationHrefs].sort(),
  );
});

it("refuses to journal a selection whose label shows nothing", () => {
  expect(nexusHistoryLabel(" \u00a0\t\n ")).toBe("");
  expect(nexusHistoryLabel("  Reader   notes ")).toBe("Reader notes");
});

it("records bounded Unicode excerpts while preserving the accepted destination and replay identity", () => {
  const title = `  ${"𐀀".repeat(125)}  complete title `;
  const query = ` ${"𐀁".repeat(205)}  complete query `;
  const command = nexusHistoryCommand({
    label_snapshot: title, query, target_href: "/media/accepted", source: "Search",
  }, "stable-mutation");
  expect(command).toEqual({
    label_snapshot: "𐀀".repeat(contract.maxLabelCodePoints),
    query: "𐀁".repeat(contract.maxQueryCodePoints),
    target_href: "/media/accepted", source: "Search", client_mutation_id: "stable-mutation",
  });
  expect(title).toContain("complete title");
});

it("rejects unbounded or malformed history results at the owned response boundary", () => {
  const recent = {
    target_href: "/libraries", label_snapshot: "Libraries", source: "Static",
    last_used_at: "2026-09-13T00:00:00Z",
  };
  expect(decodeNexusHistoryResponse({ data: { recent: [recent], frecency_by_href: { "/libraries": 0.5 } } }).data.recent).toEqual([recent]);
  for (const data of [
    { recent: Array.from({ length: 6 }, () => recent), frecency_by_href: {} },
    { recent: [], frecency_by_href: { "/libraries": 1.1 } },
    { recent: [{ ...recent, source: "Unowned" }], frecency_by_href: {} },
  ]) expect(() => decodeNexusHistoryResponse({ data })).toThrow(TypeError);
});
