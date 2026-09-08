import { describe, expect, it } from "vitest";
import { absent, present } from "@/lib/api/presence";
import { parseImportRef } from "./importsClient";
import {
  decodeImportsUrlState,
  encodeImportsUrlState,
  importsQueryParams,
  type ImportsUrlState,
} from "./importsUrlState";

/**
 * Oracle: the Imports URL contract — the pane's navigable state (spec
 * "Navigable frontend context belongs in the URL"; contract §5 parameter list)
 * and the filter combinations `GET /imports` rejects per view (contract §4
 * "Filters and views"). A URL the user can edit is untrusted input: decoding is
 * tolerant, and the state it yields can never name a combination the API
 * answers with 400.
 */
const SELECTED_REF = "media:11111111-1111-4111-8111-111111111111";

function params(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams(entries);
}

function selected() {
  const ref = parseImportRef(SELECTED_REF);
  if (ref === null) throw new Error("fixture ref must parse");
  return present(ref);
}

const HISTORY_URL: Record<string, string> = {
  view: "History",
  q: "  field notes  ",
  media_kind: "pdf",
  stage: "Extract",
  state: "Complete",
  had_failures: "true",
  from: "2026-09-01T00:00:00+02:00",
  before: "2026-09-08T00:00:00Z",
  selected: SELECTED_REF,
};

describe("Imports URL state", () => {
  it("decodes an explicit History URL and canonicalizes its values", () => {
    expect(decodeImportsUrlState(params(HISTORY_URL))).toEqual({
      view: present("History"),
      q: present("field notes"),
      mediaKind: present("pdf"),
      stage: present("Extract"),
      failureCode: absent(),
      currentState: present("Complete"),
      hadFailures: present(true),
      from: present("2026-08-31T22:00:00.000Z"),
      before: present("2026-09-08T00:00:00.000Z"),
      selected: selected(),
    });
  });

  it("drops every value the pane cannot mean", () => {
    expect(
      decodeImportsUrlState(
        params({
          view: "Everything",
          q: "   ",
          media_kind: "scroll",
          stage: "Transcribe",
          failure_code: "",
          state: "Waiting",
          had_failures: "yes",
          from: "2026-09-01",
          before: "not an instant",
          selected: "media:not-a-uuid",
        }),
      ),
    ).toEqual({
      view: absent(),
      q: absent(),
      mediaKind: absent(),
      stage: absent(),
      failureCode: absent(),
      currentState: absent(),
      hadFailures: absent(),
      from: absent(),
      before: absent(),
      selected: absent(),
    });
  });

  it("drops the filters the chosen view rejects", () => {
    const attention = decodeImportsUrlState(
      params({ ...HISTORY_URL, view: "NeedsAttention", failure_code: "E_INGEST_FAILED" }),
    );
    expect(attention.failureCode).toEqual(present("E_INGEST_FAILED"));
    expect(attention.stage).toEqual(present("Extract"));
    expect(attention.currentState).toEqual(absent());
    expect(attention.hadFailures).toEqual(absent());
    expect(attention.from).toEqual(absent());
    expect(attention.before).toEqual(absent());
    expect(attention.selected).toEqual(selected());

    const inProgress = decodeImportsUrlState(
      params({ ...HISTORY_URL, view: "InProgress", failure_code: "E_INGEST_FAILED" }),
    );
    expect(inProgress.stage).toEqual(present("Extract"));
    expect(inProgress.failureCode).toEqual(absent());
    expect(inProgress.currentState).toEqual(absent());
    expect(inProgress.from).toEqual(absent());
  });

  it("keeps every filter until an unqualified entry names its view", () => {
    const unqualified = decodeImportsUrlState(
      params({ ...HISTORY_URL, view: "", failure_code: "E_INGEST_FAILED" }),
    );
    expect(unqualified.view).toEqual(absent());
    expect(unqualified.currentState).toEqual(present("Complete"));
    expect(unqualified.from).toEqual(present("2026-08-31T22:00:00.000Z"));
  });

  it("drops only the failure flag a reason filter contradicts", () => {
    const contradicted = decodeImportsUrlState(
      params({
        view: "History",
        failure_code: "E_INGEST_FAILED",
        had_failures: "false",
      }),
    );
    expect(contradicted.failureCode).toEqual(present("E_INGEST_FAILED"));
    expect(contradicted.hadFailures).toEqual(absent());

    const agreeing = decodeImportsUrlState(
      params({
        view: "History",
        failure_code: "E_INGEST_FAILED",
        had_failures: "true",
      }),
    );
    expect(agreeing.failureCode).toEqual(present("E_INGEST_FAILED"));
    expect(agreeing.hadFailures).toEqual(present(true));
  });

  it("encodes a canonical, stable-ordered query that decodes back unchanged", () => {
    const decoded = decodeImportsUrlState(params(HISTORY_URL));
    const encoded = encodeImportsUrlState(decoded, params({ stale: "1" }));

    expect([...encoded.keys()]).toEqual([
      "view",
      "q",
      "media_kind",
      "stage",
      "state",
      "had_failures",
      "from",
      "before",
      "selected",
    ]);
    expect(encoded.get("q")).toBe("field notes");
    expect(encoded.get("from")).toBe("2026-08-31T22:00:00.000Z");
    expect(decodeImportsUrlState(encoded)).toEqual(decoded);
  });

  it("encodes nothing for a pane that has not chosen a view", () => {
    const empty: ImportsUrlState = decodeImportsUrlState(new URLSearchParams());
    expect(encodeImportsUrlState(empty, new URLSearchParams()).toString()).toBe(
      "",
    );
  });

  it("builds the API query for the view the pane resolved", () => {
    const decoded = decodeImportsUrlState(
      params({ ...HISTORY_URL, view: "", failure_code: "E_INGEST_FAILED" }),
    );

    expect(importsQueryParams("NeedsAttention", decoded).toString()).toBe(
      new URLSearchParams({
        view: "NeedsAttention",
        q: "field notes",
        media_kind: "pdf",
        stage: "Extract",
        failure_code: "E_INGEST_FAILED",
      }).toString(),
    );
    expect(importsQueryParams("History", decoded).toString()).toBe(
      new URLSearchParams({
        view: "History",
        q: "field notes",
        media_kind: "pdf",
        stage: "Extract",
        failure_code: "E_INGEST_FAILED",
        state: "Complete",
        had_failures: "true",
        from: "2026-08-31T22:00:00.000Z",
        before: "2026-09-08T00:00:00.000Z",
      }).toString(),
    );
  });
});
