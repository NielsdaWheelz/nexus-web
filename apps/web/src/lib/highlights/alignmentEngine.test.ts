/**
 * Tests for the Alignment Engine.
 *
 * These are pure logic tests - no DOM required.
 *
 * @see docs/v1/s2/s2_prs/s2_pr10.md §13.1
 */

import { describe, it, expect } from "vitest";
import {
  ROW_HEIGHT,
  ROW_GAP,
  compareRowsForAlignment,
  applyCollisionResolution,
  computeAlignedRows,
  computeScrollTarget,
  SCROLL_TARGET_FRACTION,
  type AlignmentHighlight,
} from "./alignmentEngine";

// =============================================================================
// Test Fixtures
// =============================================================================

function createHighlight(
  id: string,
  start: number,
  end: number,
  createdAt: string
): AlignmentHighlight {
  return {
    id,
    start_offset: start,
    end_offset: end,
    created_at: createdAt,
  };
}

// =============================================================================
// Sort Tests (§13.1 #1)
// =============================================================================

describe("compareRowsForAlignment", () => {
  it("sorts by desiredY ascending", () => {
    const h1 = createHighlight("h1", 0, 10, "2024-01-01T00:00:00Z");
    const h2 = createHighlight("h2", 0, 10, "2024-01-01T00:00:00Z");

    const rows = [
      { highlight: h1, desiredY: 100 },
      { highlight: h2, desiredY: 50 },
    ];

    rows.sort(compareRowsForAlignment);

    expect(rows[0].highlight.id).toBe("h2");
    expect(rows[1].highlight.id).toBe("h1");
  });

  it("breaks ties by start_offset", () => {
    const h1 = createHighlight("h1", 100, 200, "2024-01-01T00:00:00Z");
    const h2 = createHighlight("h2", 50, 200, "2024-01-01T00:00:00Z");

    const rows = [
      { highlight: h1, desiredY: 100 },
      { highlight: h2, desiredY: 100 },
    ];

    rows.sort(compareRowsForAlignment);

    expect(rows[0].highlight.id).toBe("h2"); // earlier start
    expect(rows[1].highlight.id).toBe("h1");
  });

  it("breaks ties by end_offset", () => {
    const h1 = createHighlight("h1", 50, 200, "2024-01-01T00:00:00Z");
    const h2 = createHighlight("h2", 50, 150, "2024-01-01T00:00:00Z");

    const rows = [
      { highlight: h1, desiredY: 100 },
      { highlight: h2, desiredY: 100 },
    ];

    rows.sort(compareRowsForAlignment);

    expect(rows[0].highlight.id).toBe("h2"); // shorter span
    expect(rows[1].highlight.id).toBe("h1");
  });

  it("breaks ties by created_at (older first)", () => {
    const h1 = createHighlight("h1", 50, 150, "2024-01-02T00:00:00Z");
    const h2 = createHighlight("h2", 50, 150, "2024-01-01T00:00:00Z");

    const rows = [
      { highlight: h1, desiredY: 100 },
      { highlight: h2, desiredY: 100 },
    ];

    rows.sort(compareRowsForAlignment);

    expect(rows[0].highlight.id).toBe("h2"); // older
    expect(rows[1].highlight.id).toBe("h1");
  });

  it("breaks ties by id lexicographically", () => {
    const h1 = createHighlight("h-b", 50, 150, "2024-01-01T00:00:00Z");
    const h2 = createHighlight("h-a", 50, 150, "2024-01-01T00:00:00Z");

    const rows = [
      { highlight: h1, desiredY: 100 },
      { highlight: h2, desiredY: 100 },
    ];

    rows.sort(compareRowsForAlignment);

    expect(rows[0].highlight.id).toBe("h-a");
    expect(rows[1].highlight.id).toBe("h-b");
  });

  it("uses full tiebreaker chain correctly", () => {
    const highlights = [
      createHighlight("h1", 100, 200, "2024-01-03T00:00:00Z"),
      createHighlight("h2", 50, 150, "2024-01-02T00:00:00Z"),
      createHighlight("h3", 50, 150, "2024-01-01T00:00:00Z"),
      createHighlight("h4", 50, 100, "2024-01-01T00:00:00Z"),
    ];

    const rows = highlights.map((h) => ({
      highlight: h,
      desiredY: 100, // all same desiredY
    }));

    rows.sort(compareRowsForAlignment);

    // h4: earliest start (50), shortest span (50-100)
    // h3: same start (50), same end (150), oldest (01-01)
    // h2: same start (50), same end (150), newer (01-02)
    // h1: later start (100)
    expect(rows.map((r) => r.highlight.id)).toEqual(["h4", "h3", "h2", "h1"]);
  });
});

// =============================================================================
// Collision Resolution Tests (§13.1 #2)
// =============================================================================

describe("applyCollisionResolution", () => {
  it("does not change positions for non-overlapping rows", () => {
    const h1 = createHighlight("h1", 0, 10, "2024-01-01T00:00:00Z");
    const h2 = createHighlight("h2", 10, 20, "2024-01-01T00:00:00Z");

    const rows = [
      { highlight: h1, desiredY: 0 },
      { highlight: h2, desiredY: 100 }, // Well separated
    ];

    const result = applyCollisionResolution(rows);

    expect(result[0].top).toBe(0);
    expect(result[1].top).toBe(100);
  });

  it("pushes down overlapping rows with ROW_GAP", () => {
    const h1 = createHighlight("h1", 0, 10, "2024-01-01T00:00:00Z");
    const h2 = createHighlight("h2", 10, 20, "2024-01-01T00:00:00Z");

    const rows = [
      { highlight: h1, desiredY: 0 },
      { highlight: h2, desiredY: 10 }, // Would overlap
    ];

    const result = applyCollisionResolution(rows);

    expect(result[0].top).toBe(0);
    // Second row pushed to: first row bottom + gap = 0 + 28 + 4 = 32
    expect(result[1].top).toBe(ROW_HEIGHT + ROW_GAP);
  });

  it("maintains push-down monotonicity (no row moves up)", () => {
    const highlights = [
      createHighlight("h1", 0, 10, "2024-01-01T00:00:00Z"),
      createHighlight("h2", 10, 20, "2024-01-01T00:00:00Z"),
      createHighlight("h3", 20, 30, "2024-01-01T00:00:00Z"),
    ];

    const rows = highlights.map((h, i) => ({
      highlight: h,
      desiredY: i * 10, // All overlapping
    }));

    const result = applyCollisionResolution(rows);

    // Each top should be >= its desiredY
    for (let i = 0; i < result.length; i++) {
      expect(result[i].top).toBeGreaterThanOrEqual(result[i].desiredY);
    }

    // Each subsequent row should be at least ROW_HEIGHT + ROW_GAP below previous
    for (let i = 1; i < result.length; i++) {
      const minTop = result[i - 1].top + ROW_HEIGHT + ROW_GAP;
      expect(result[i].top).toBeGreaterThanOrEqual(minTop);
    }
  });

  it("handles empty input", () => {
    const result = applyCollisionResolution([]);
    expect(result).toEqual([]);
  });

  it("handles single row", () => {
    const h1 = createHighlight("h1", 0, 10, "2024-01-01T00:00:00Z");
    const rows = [{ highlight: h1, desiredY: 50 }];

    const result = applyCollisionResolution(rows);

    expect(result.length).toBe(1);
    expect(result[0].top).toBe(50);
    expect(result[0].desiredY).toBe(50);
  });

  it("handles negative desiredY (anchor above viewport)", () => {
    const h1 = createHighlight("h1", 0, 10, "2024-01-01T00:00:00Z");
    const h2 = createHighlight("h2", 10, 20, "2024-01-01T00:00:00Z");

    const rows = [
      { highlight: h1, desiredY: -50 },
      { highlight: h2, desiredY: 100 },
    ];

    const result = applyCollisionResolution(rows);

    expect(result[0].top).toBe(-50);
    expect(result[1].top).toBe(100);
  });

  it("handles many tightly packed highlights", () => {
    const highlights = Array.from({ length: 10 }, (_, i) =>
      createHighlight(`h${i}`, i * 10, (i + 1) * 10, "2024-01-01T00:00:00Z")
    );

    // All want same position
    const rows = highlights.map((h) => ({
      highlight: h,
      desiredY: 0,
    }));

    const result = applyCollisionResolution(rows);

    // All rows should be stacked with proper spacing
    for (let i = 0; i < result.length; i++) {
      const expectedTop = i * (ROW_HEIGHT + ROW_GAP);
      expect(result[i].top).toBe(expectedTop);
    }
  });
});

// =============================================================================
// desiredY Computation Tests (§13.1 #3)
// =============================================================================

describe("computeAlignedRows - desiredY computation", () => {
  it("computes desiredY from cached anchor positions + scrollTop", () => {
    const h1 = createHighlight("h1", 0, 10, "2024-01-01T00:00:00Z");

    const anchorPositions = new Map<string, number>();
    anchorPositions.set("h1", 500); // anchor at 500px in document

    const result = computeAlignedRows([h1], anchorPositions, 200); // scrolled 200px

    expect(result.rows[0].desiredY).toBe(300); // 500 - 200
  });

  it("handles various scrollTop values", () => {
    const h1 = createHighlight("h1", 0, 10, "2024-01-01T00:00:00Z");

    const anchorPositions = new Map<string, number>();
    anchorPositions.set("h1", 1000);

    // No scroll
    let result = computeAlignedRows([h1], anchorPositions, 0);
    expect(result.rows[0].desiredY).toBe(1000);

    // Scrolled to anchor
    result = computeAlignedRows([h1], anchorPositions, 1000);
    expect(result.rows[0].desiredY).toBe(0);

    // Scrolled past anchor
    result = computeAlignedRows([h1], anchorPositions, 1500);
    expect(result.rows[0].desiredY).toBe(-500);
  });
});

// =============================================================================
// Sort + Push-Down Integration Tests (§13.1 #4)
// =============================================================================

describe("computeAlignedRows - integration", () => {
  it("handles highlights whose canonical order differs from visual order", () => {
    // h1 created first but appears lower in document
    // h2 created second but appears higher
    const h1 = createHighlight("h1", 100, 150, "2024-01-01T00:00:00Z");
    const h2 = createHighlight("h2", 50, 100, "2024-01-02T00:00:00Z");

    const anchorPositions = new Map<string, number>();
    anchorPositions.set("h1", 500); // lower in document
    anchorPositions.set("h2", 200); // higher in document

    const result = computeAlignedRows([h1, h2], anchorPositions, 0);

    // h2 should come first (visual order takes precedence)
    expect(result.rows[0].highlight.id).toBe("h2");
    expect(result.rows[1].highlight.id).toBe("h1");
  });

  it("produces deterministic output regardless of input order", () => {
    const h1 = createHighlight("h1", 0, 10, "2024-01-01T00:00:00Z");
    const h2 = createHighlight("h2", 10, 20, "2024-01-02T00:00:00Z");
    const h3 = createHighlight("h3", 20, 30, "2024-01-03T00:00:00Z");

    const anchorPositions = new Map<string, number>();
    anchorPositions.set("h1", 100);
    anchorPositions.set("h2", 100);
    anchorPositions.set("h3", 100);

    // Different input orders should produce same output
    const result1 = computeAlignedRows([h1, h2, h3], anchorPositions, 0);
    const result2 = computeAlignedRows([h3, h1, h2], anchorPositions, 0);
    const result3 = computeAlignedRows([h2, h3, h1], anchorPositions, 0);

    const ids1 = result1.rows.map((r) => r.highlight.id);
    const ids2 = result2.rows.map((r) => r.highlight.id);
    const ids3 = result3.rows.map((r) => r.highlight.id);

    expect(ids1).toEqual(ids2);
    expect(ids2).toEqual(ids3);
  });

  it("correctly integrates sort + collision resolution", () => {
    const h1 = createHighlight("h1", 0, 10, "2024-01-01T00:00:00Z");
    const h2 = createHighlight("h2", 10, 20, "2024-01-02T00:00:00Z");

    const anchorPositions = new Map<string, number>();
    // Same visual position - will need collision resolution
    anchorPositions.set("h1", 100);
    anchorPositions.set("h2", 100);

    const result = computeAlignedRows([h1, h2], anchorPositions, 0);

    // h1 comes first (earlier start, older)
    expect(result.rows[0].highlight.id).toBe("h1");
    expect(result.rows[0].top).toBe(100);

    // h2 pushed down
    expect(result.rows[1].highlight.id).toBe("h2");
    expect(result.rows[1].top).toBe(100 + ROW_HEIGHT + ROW_GAP);
  });
});

// =============================================================================
// Missing Anchor Handling Tests (§13.1 #5)
// =============================================================================

describe("computeAlignedRows - missing anchors", () => {
  it("excludes rows with missing anchors from output", () => {
    const h1 = createHighlight("h1", 0, 10, "2024-01-01T00:00:00Z");
    const h2 = createHighlight("h2", 10, 20, "2024-01-02T00:00:00Z");

    const anchorPositions = new Map<string, number>();
    anchorPositions.set("h1", 100);
    // h2 has no anchor position

    const result = computeAlignedRows([h1, h2], anchorPositions, 0);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].highlight.id).toBe("h1");
    expect(result.missingAnchorIds).toEqual(["h2"]);
  });

  it("reports all missing anchors", () => {
    const h1 = createHighlight("h1", 0, 10, "2024-01-01T00:00:00Z");
    const h2 = createHighlight("h2", 10, 20, "2024-01-02T00:00:00Z");
    const h3 = createHighlight("h3", 20, 30, "2024-01-03T00:00:00Z");

    const anchorPositions = new Map<string, number>();
    anchorPositions.set("h2", 100);
    // h1 and h3 have no anchors

    const result = computeAlignedRows([h1, h2, h3], anchorPositions, 0);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].highlight.id).toBe("h2");
    expect(result.missingAnchorIds).toContain("h1");
    expect(result.missingAnchorIds).toContain("h3");
  });

  it("handles all anchors missing", () => {
    const h1 = createHighlight("h1", 0, 10, "2024-01-01T00:00:00Z");
    const h2 = createHighlight("h2", 10, 20, "2024-01-02T00:00:00Z");

    const anchorPositions = new Map<string, number>();
    // No anchors

    const result = computeAlignedRows([h1, h2], anchorPositions, 0);

    expect(result.rows.length).toBe(0);
    expect(result.missingAnchorIds).toEqual(["h1", "h2"]);
  });

  it("handles empty input", () => {
    const result = computeAlignedRows([], new Map(), 0);

    expect(result.rows).toEqual([]);
    expect(result.missingAnchorIds).toEqual([]);
  });
});

// =============================================================================
// Scroll Target Tests
// =============================================================================

describe("computeScrollTarget", () => {
  it("computes scroll target for SCROLL_TARGET_FRACTION", () => {
    const anchorTop = 1000;
    const containerHeight = 500;

    const target = computeScrollTarget(anchorTop, containerHeight);

    // Expected: 1000 - (500 * 0.2) = 1000 - 100 = 900
    expect(target).toBe(anchorTop - containerHeight * SCROLL_TARGET_FRACTION);
  });

  it("handles anchor at top of document", () => {
    const target = computeScrollTarget(100, 500);

    // 100 - 100 = 0
    expect(target).toBe(0);
  });

  it("can produce negative scroll target (anchor near top)", () => {
    const target = computeScrollTarget(50, 500);

    // 50 - 100 = -50 (browser will clamp to 0)
    expect(target).toBe(-50);
  });
});

// =============================================================================
// Constants Tests
// =============================================================================

describe("constants", () => {
  it("has expected values per spec", () => {
    expect(ROW_HEIGHT).toBe(28);
    expect(ROW_GAP).toBe(4);
    expect(SCROLL_TARGET_FRACTION).toBe(0.2);
  });
});
