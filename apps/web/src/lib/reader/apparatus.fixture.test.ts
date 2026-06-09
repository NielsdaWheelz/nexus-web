import { describe, expect, it } from "vitest";
import {
  readerApparatusPayloadFixtures,
  type ReaderApparatusFixtureEntry,
} from "./__fixtures__/reader-apparatus";
import {
  assertReaderApparatusResponse,
  buildReaderApparatusRows,
  readerApparatusRowPresentation,
  type ReaderApparatusItemKind,
  type ReaderApparatusResponse,
  type ReaderApparatusRow,
} from "./apparatus";

const MARKER_KINDS = new Set<ReaderApparatusItemKind>([
  "footnote_ref",
  "endnote_ref",
  "bibliography_ref",
  "sidenote_ref",
  "margin_note_ref",
]);
const TARGET_KINDS = new Set<ReaderApparatusItemKind>([
  "footnote",
  "endnote",
  "bibliography_entry",
  "sidenote",
  "margin_note",
  "reference_section",
]);

function addAccount(
  accounts: Map<string, Set<string>>,
  stableKey: string,
  account: string,
) {
  const existing = accounts.get(stableKey);
  if (existing) {
    existing.add(account);
  } else {
    accounts.set(stableKey, new Set([account]));
  }
}

function assertRowsAccountForPayloadGraph(
  fixtureId: string,
  apparatus: ReaderApparatusResponse,
  rows: ReaderApparatusRow[],
) {
  const failures: string[] = [];
  const itemsByKey = new Map(
    apparatus.items.map((item) => [item.stable_key, item]),
  );
  const edgesByKey = new Map(
    apparatus.edges.map((edge) => [edge.stable_key, edge]),
  );
  const itemAccounts = new Map<string, Set<string>>();
  const representedEdges = new Set<string>();
  const rowIds = new Set<string>();

  for (const row of rows) {
    if (rowIds.has(row.id)) {
      failures.push(`${fixtureId}: duplicate row ${row.id}`);
    }
    rowIds.add(row.id);

    if (row.id !== row.marker.stable_key) {
      failures.push(
        `${fixtureId}: row ${row.id} does not use marker stable key ${row.marker.stable_key}`,
      );
    }
    if (!itemsByKey.has(row.marker.stable_key)) {
      failures.push(
        `${fixtureId}: row ${row.id} marker ${row.marker.stable_key} is not in payload items`,
      );
    }

    const markerIsInline = MARKER_KINDS.has(row.marker.kind);
    const markerIsTarget = TARGET_KINDS.has(row.marker.kind);
    const targetOnly =
      markerIsTarget &&
      row.edges.length === 0 &&
      row.targets.length === 1 &&
      row.targets[0]?.stable_key === row.marker.stable_key;

    if (markerIsInline) {
      addAccount(itemAccounts, row.marker.stable_key, "marker row");
      if (row.edges.length !== row.targets.length) {
        failures.push(
          `${fixtureId}: row ${row.id} has ${row.edges.length} edges but ${row.targets.length} targets`,
        );
      }
    } else if (targetOnly) {
      addAccount(itemAccounts, row.marker.stable_key, "target-only row");
    } else {
      failures.push(
        `${fixtureId}: row ${row.id} is neither marker row nor target-only row`,
      );
    }

    row.edges.forEach((edge, index) => {
      const target = row.targets[index] ?? null;
      if (!edgesByKey.has(edge.stable_key)) {
        failures.push(
          `${fixtureId}: row ${row.id} contains unknown edge ${edge.stable_key}`,
        );
      }
      representedEdges.add(edge.stable_key);
      if (edge.from_stable_key !== row.marker.stable_key) {
        failures.push(
          `${fixtureId}: row ${row.id} contains edge ${edge.stable_key} from ${edge.from_stable_key}`,
        );
      }
      if (target?.stable_key !== edge.to_stable_key) {
        failures.push(
          `${fixtureId}: row ${row.id} edge ${edge.stable_key} points to ${edge.to_stable_key} but target slot is ${target?.stable_key ?? "missing"}`,
        );
      }
      if (target && !TARGET_KINDS.has(target.kind)) {
        failures.push(
          `${fixtureId}: row ${row.id} edge ${edge.stable_key} target ${target.stable_key} is ${target.kind}`,
        );
      }
      if (target) {
        addAccount(itemAccounts, target.stable_key, "embedded linked target");
      }
    });

    for (const target of row.targets) {
      if (!itemsByKey.has(target.stable_key)) {
        failures.push(
          `${fixtureId}: row ${row.id} target ${target.stable_key} is not in payload items`,
        );
      }
    }
  }

  for (const edge of apparatus.edges) {
    const row = rows.find(
      (candidate) => candidate.marker.stable_key === edge.from_stable_key,
    );
    if (!row) {
      failures.push(
        `${fixtureId}: edge ${edge.stable_key} has no row for source ${edge.from_stable_key}`,
      );
      continue;
    }
    if (!row.edges.some((candidate) => candidate.stable_key === edge.stable_key)) {
      failures.push(
        `${fixtureId}: edge ${edge.stable_key} is missing from row ${row.id}`,
      );
    }
    if (!row.targets.some((target) => target.stable_key === edge.to_stable_key)) {
      failures.push(
        `${fixtureId}: edge ${edge.stable_key} target ${edge.to_stable_key} is missing from row ${row.id}`,
      );
    }
  }

  const expectedEdgeKeys = apparatus.edges
    .map((edge) => edge.stable_key)
    .sort();
  const actualEdgeKeys = [...representedEdges].sort();
  if (actualEdgeKeys.join("\n") !== expectedEdgeKeys.join("\n")) {
    failures.push(
      `${fixtureId}: represented edge keys do not match payload edge keys`,
    );
  }

  for (const item of apparatus.items) {
    const accounts = itemAccounts.get(item.stable_key) ?? new Set<string>();
    if (MARKER_KINDS.has(item.kind) && !accounts.has("marker row")) {
      failures.push(
        `${fixtureId}: marker item ${item.stable_key} is not a marker row`,
      );
    }
    if (TARGET_KINDS.has(item.kind) && accounts.size === 0) {
      failures.push(
        `${fixtureId}: target item ${item.stable_key} is not embedded or target-only`,
      );
    }
  }

  expect(failures).toEqual([]);
}

function fixtureEntry(fixtureId: string): ReaderApparatusFixtureEntry {
  const entry = readerApparatusPayloadFixtures.find(
    (candidate) => candidate.fixtureId === fixtureId,
  );
  if (!entry) {
    throw new Error(`Missing reader apparatus fixture ${fixtureId}`);
  }
  return entry;
}

describe("reader apparatus real API payload fixtures", () => {
  it.each(readerApparatusPayloadFixtures)(
    "validates and projects $fixtureId",
    ({
      fixtureId,
      payload,
      expectedStatus,
      expectedItemCount,
      expectedEdgeCount,
      expectedRowCount,
      bodyNeedles,
    }) => {
      const apparatus = assertReaderApparatusResponse(payload.apparatus);
      const rows = buildReaderApparatusRows(apparatus);
      const searchableBodyText = rows
        .flatMap((row) => [
          row.marker.body_text,
          ...row.targets.map((target) => target.body_text),
        ])
        .filter((text): text is string => Boolean(text))
        .join("\n");

      expect(payload.source_fixture_path).toBeTruthy();
      expect(payload.source_fixture_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(apparatus.status).toBe(expectedStatus);
      expect(apparatus.items).toHaveLength(expectedItemCount);
      expect(apparatus.edges).toHaveLength(expectedEdgeCount);
      expect(rows).toHaveLength(expectedRowCount);
      assertRowsAccountForPayloadGraph(payload.fixture_id, apparatus, rows);

      if (expectedRowCount === 0) {
        expect(apparatus.status).toBe("empty");
        expect(apparatus.capabilities.has_sidecar_items).toBe(false);
        return;
      }

      expect(["partial", "ready"]).toContain(apparatus.status);
      expect(apparatus.capabilities.has_sidecar_items).toBe(true);
      expect(rows.every((row) => row.targets.length > 0 || row.edges.length === 0)).toBe(
        true,
      );
      for (const needle of bodyNeedles) {
        expect(searchableBodyText, `${fixtureId} body needle ${needle}`).toContain(
          needle,
        );
      }
    },
  );

  it("keeps target-only Numinous margin notes non-previewable but target-activatable", () => {
    const numinousPayload = fixtureEntry("html-numinous-ttft-full").payload;
    const apparatus = assertReaderApparatusResponse(numinousPayload.apparatus);
    const rows = buildReaderApparatusRows(apparatus);
    const presentation = readerApparatusRowPresentation(rows[0], apparatus.capabilities);

    expect(rows[0].marker.kind).toBe("margin_note");
    expect(rows[0].edges).toEqual([]);
    expect(presentation.canPreview).toBe(false);
    expect(presentation.canActivateMarker).toBe(false);
    expect(presentation.canActivateTarget).toBe(true);
  });

  it("keeps the native PDF citation graph as linked bibliography rows", () => {
    const attentionPdfPayload = fixtureEntry("pdf-attention-native-link-graph").payload;
    const apparatus = assertReaderApparatusResponse(attentionPdfPayload.apparatus);
    const rows = buildReaderApparatusRows(apparatus);

    expect(rows[0].marker.kind).toBe("bibliography_ref");
    expect(rows[0].edge?.relation).toBe("cites_bibliography_entry");
    expect(rows.some((row) => row.marker.label === "[13]")).toBe(true);
  });
});
