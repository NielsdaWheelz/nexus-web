import { afterEach, describe, expect, it } from "vitest";
import {
  CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME,
  CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME,
  createPaneFindHighlightOwner,
  type PaneFindHighlightOwner,
} from "./paneFindHighlightRegistry";

const owners: PaneFindHighlightOwner[] = [];

function range(text: string): Range {
  const node = document.createTextNode(text);
  document.body.append(node);
  const value = document.createRange();
  value.selectNodeContents(node);
  return value;
}

function currentRanges(name: string): AbstractRange[] {
  const highlight = CSS.highlights.get(name);
  return highlight ? Array.from(highlight) : [];
}

function priority(name: string): number | undefined {
  return CSS.highlights.get(name)?.priority;
}

afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.clear();
  }
  document.body.replaceChildren();
});

describe("canonical text Find highlight owners", () => {
  it("publishes all and active ranges under the fixed names", () => {
    const owner = createPaneFindHighlightOwner();
    owners.push(owner);
    const first = range("all");
    const active = range("active");

    owner.publish({ all: [first, active], active: [active] });

    expect(currentRanges(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME)).toEqual([
      first,
      active,
    ]);
    expect(currentRanges(CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME)).toEqual([
      active,
    ]);
  });

  it("updates and clears one owner without erasing another owner", () => {
    const firstOwner = createPaneFindHighlightOwner();
    const secondOwner = createPaneFindHighlightOwner();
    owners.push(firstOwner, secondOwner);
    const first = range("first");
    const firstReplacement = range("first replacement");
    const second = range("second");

    firstOwner.publish({ all: [first], active: [first] });
    secondOwner.publish({ all: [second], active: [second] });
    firstOwner.publish({
      all: [firstReplacement],
      active: [firstReplacement],
    });

    expect(currentRanges(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME)).toEqual([
      firstReplacement,
      second,
    ]);
    expect(currentRanges(CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME)).toEqual([
      firstReplacement,
      second,
    ]);

    firstOwner.clear();

    expect(currentRanges(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME)).toEqual([
      second,
    ]);
    expect(currentRanges(CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME)).toEqual([
      second,
    ]);
  });

  it("removes the fixed registry entries after the last owner clears", () => {
    const owner = createPaneFindHighlightOwner();
    owners.push(owner);
    owner.publish({ all: [range("match")], active: [] });

    owner.clear();

    expect(
      CSS.highlights.has(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME),
    ).toBe(false);
    expect(
      CSS.highlights.has(CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME),
    ).toBe(false);
  });

  it("paints the active highlight above the passive highlight by explicit priority", () => {
    const owner = createPaneFindHighlightOwner();
    owners.push(owner);
    const active = range("active");

    owner.publish({ all: [active], active: [active] });

    expect(priority(CANONICAL_TEXT_FIND_ACTIVE_HIGHLIGHT_NAME)).toBeGreaterThan(
      priority(CANONICAL_TEXT_FIND_ALL_HIGHLIGHT_NAME)!,
    );
  });
});
