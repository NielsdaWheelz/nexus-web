import { describe, expect, it } from "vitest";

import {
  decodeNotePageEnvelope,
  decodeNotePagesEnvelope,
} from "@/lib/notes/pageContract";

const PAGE_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const UPDATED_AT = "2026-08-25T12:00:00Z";
const LOCAL_DATE = "2026-08-25";

function summary() {
  return {
    id: PAGE_ID,
    title: "Strict page contract",
    updatedAt: UPDATED_AT,
  };
}

function detail(dailyPage: unknown = { kind: "Absent" }) {
  return {
    ...summary(),
    dailyPage,
  };
}

describe("Notes Page read contract", () => {
  it("accepts the exact list and detail envelopes and derives action identity after decode", () => {
    expect(
      decodeNotePagesEnvelope({ data: { pages: [summary()] } }),
    ).toEqual([
      {
        ...summary(),
        actionSubject: { ref: `page:${PAGE_ID}` },
      },
    ]);
    expect(
      decodeNotePageEnvelope({
        data: detail({
          kind: "Present",
          value: { localDate: LOCAL_DATE },
        }),
      }),
    ).toEqual({
      ...summary(),
      actionSubject: { ref: `page:${PAGE_ID}` },
      dailyPage: {
        kind: "Present",
        value: { localDate: LOCAL_DATE },
      },
    });
  });

  it.each([
    { data: {} },
    { data: { pages: [] }, compatibility: true },
    { data: { pages: [{ ...summary(), updated_at: UPDATED_AT }] } },
    { data: { pages: [{ ...summary(), id: PAGE_ID.toUpperCase() }] } },
    { data: { pages: [{ ...summary(), title: "" }] } },
    { data: { pages: [{ ...summary(), title: "x".repeat(201) }] } },
    { data: { pages: [{ ...summary(), updatedAt: "2026-08-25" }] } },
    { data: { pages: [{ ...summary(), compatibility: true }] } },
  ])("rejects malformed or compatibility list payload %#", (payload) => {
    expect(() => decodeNotePagesEnvelope(payload)).toThrow();
  });

  it.each([
    { data: { ...detail(), dailyPage: null } },
    { data: { ...summary() } },
    { data: detail({ kind: "Absent", value: null }) },
    { data: detail({ kind: "Present" }) },
    {
      data: detail({
        kind: "Present",
        value: { localDate: "2026-02-30" },
      }),
    },
    {
      data: detail({
        kind: "Present",
        value: { localDate: LOCAL_DATE, compatibility: true },
      }),
    },
    { data: detail(), compatibility: true },
  ])("rejects malformed or compatibility detail payload %#", (payload) => {
    expect(() => decodeNotePageEnvelope(payload)).toThrow();
  });
});
