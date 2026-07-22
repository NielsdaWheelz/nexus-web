import { describe, expect, it } from "vitest";
import type { CollectionActivity } from "@/lib/collections/types";
import { decodePublicationDate } from "@/lib/dates/publicationDate";
import {
  collectionActivityText,
  formatCollectionPublicationDate,
} from "./collectionRowFormatting";

describe("collection activity grammar", () => {
  const cases: Array<[CollectionActivity, string, string]> = [
    [
      {
        kind: "Unread",
        modality: "Read",
        totalMinutes: { kind: "Present", value: { value: 18 } },
      },
      "Unread · ≈18 min",
      "Unread, about 18 minutes to read",
    ],
    [
      { kind: "Unread", modality: "Read", totalMinutes: { kind: "Absent" } },
      "Unread",
      "Unread",
    ],
    [
      {
        kind: "Unread",
        modality: "Read",
        totalMinutes: { kind: "Present", value: { value: 1 } },
      },
      "Unread · ≈1 min",
      "Unread, about 1 minute to read",
    ],
    [
      {
        kind: "InProgress",
        modality: "Read",
        fraction: { kind: "Present", value: { value: 0.42 } },
        remainingMinutes: { kind: "Present", value: { value: 5 } },
      },
      "42% · ≈5 min left",
      "42 percent complete, about 5 minutes left to read",
    ],
    [
      {
        kind: "InProgress",
        modality: "Watch",
        fraction: { kind: "Present", value: { value: 0.5 } },
        remainingMinutes: { kind: "Absent" },
      },
      "50%",
      "50 percent watching progress",
    ],
    [
      {
        kind: "InProgress",
        modality: "Listen",
        fraction: { kind: "Absent" },
        remainingMinutes: { kind: "Present", value: { value: 7 } },
      },
      "≈7 min left",
      "About 7 minutes left to listen",
    ],
    [
      {
        kind: "InProgress",
        modality: "Listen",
        fraction: { kind: "Present", value: { value: 0.9 } },
        remainingMinutes: { kind: "Present", value: { value: 1 } },
      },
      "90% · ≈1 min left",
      "90 percent complete, about 1 minute left to listen",
    ],
    [
      {
        kind: "InProgress",
        modality: "Watch",
        fraction: { kind: "Absent" },
        remainingMinutes: { kind: "Present", value: { value: 1 } },
      },
      "≈1 min left",
      "About 1 minute left to watch",
    ],
    [
      { kind: "Finished", modality: "Read" },
      "Finished",
      "Finished reading",
    ],
    [
      { kind: "Finished", modality: "Listen" },
      "Finished",
      "Finished listening",
    ],
    [
      { kind: "Finished", modality: "Watch" },
      "Finished",
      "Finished watching",
    ],
    [
      { kind: "Unplayed", count: { value: 1 } },
      "1 new",
      "1 new unplayed episode",
    ],
    [
      { kind: "Unplayed", count: { value: 3 } },
      "3 new",
      "3 new unplayed episodes",
    ],
  ];

  it.each(cases)("projects %s truthfully", (activity, visible, accessible) => {
    expect(collectionActivityText(activity)).toEqual({ visible, accessible });
  });
});

describe("collection publication date grammar", () => {
  it.each([
    ["2025", "2025"],
    ["2025-02", "February 2025"],
    ["2025-02-03", "February 3, 2025"],
    ["2025-02-03T12:30:00Z", "February 3, 2025"],
  ])("formats %s", (value, expected) => {
    expect(
      formatCollectionPublicationDate(decodePublicationDate(value, "date")),
    ).toBe(expected);
  });
});
