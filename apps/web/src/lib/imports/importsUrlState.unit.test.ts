import { describe, expect, it } from "vitest";
import { absent, present } from "@/lib/api/presence";
import { parseImportRef } from "./importRef";
import {
  decodeImportsUrlState,
  encodeImportsUrlState,
  importsQueryParams,
  type ImportsUrlState,
} from "./importsUrlState";

/**
 * Oracle: the Imports URL contract — the pane's navigable state (spec
 * "Navigable frontend context belongs in the URL"; contract §5 parameter list),
 * the calendar-date history bounds of D17, the closed failure-code catalog of
 * D18, and the filter combinations `GET /imports` rejects per view (contract §4
 * "Filters and views"). A URL the user can edit is untrusted input: decoding is
 * tolerant and keeps what the reader wrote; the API query is what can never
 * name a combination the server answers with 400.
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
  from: "2026-09-01",
  before: "2026-09-08",
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
      from: present("2026-09-01"),
      before: present("2026-09-08"),
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
          failure_code: "E_NOT_A_CATALOGUED_CODE",
          state: "Waiting",
          had_failures: "yes",
          from: "2026-09-31",
          before: "2026-09-08T00:00:00Z",
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

  it("keeps a reader's History filters when the pane names another view", () => {
    const decoded = decodeImportsUrlState(
      params({ ...HISTORY_URL, view: "NeedsAttention" }),
    );

    expect(decoded.view).toEqual(present("NeedsAttention"));
    expect(decoded.currentState).toEqual(present("Complete"));
    expect(decoded.hadFailures).toEqual(present(true));
    expect(decoded.from).toEqual(present("2026-09-01"));
    expect(decoded.before).toEqual(present("2026-09-08"));
    expect(encodeImportsUrlState(decoded, new URLSearchParams()).get("from")).toBe(
      "2026-09-01",
    );
  });

  it("drops the filters the queried view rejects", () => {
    const decoded = decodeImportsUrlState(
      params({ ...HISTORY_URL, failure_code: "E_INGEST_FAILED" }),
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
    expect(importsQueryParams("InProgress", decoded).toString()).toBe(
      new URLSearchParams({
        view: "InProgress",
        q: "field notes",
        media_kind: "pdf",
        stage: "Extract",
      }).toString(),
    );
  });

  it("sends History bounds as the explicit UTC instants the API accepts", () => {
    const decoded = decodeImportsUrlState(params(HISTORY_URL));
    const query = importsQueryParams("History", decoded);

    expect(query.get("from")).toBe("2026-09-01T00:00:00Z");
    expect(query.get("before")).toBe("2026-09-08T00:00:00Z");
  });

  it("drops only the failure flag a reason filter contradicts", () => {
    const contradicted = decodeImportsUrlState(
      params({
        view: "History",
        failure_code: "E_INGEST_FAILED",
        had_failures: "false",
      }),
    );
    const contradictedQuery = importsQueryParams("History", contradicted);
    expect(contradictedQuery.get("failure_code")).toBe("E_INGEST_FAILED");
    expect(contradictedQuery.get("had_failures")).toBeNull();

    const agreeing = decodeImportsUrlState(
      params({
        view: "History",
        failure_code: "E_INGEST_FAILED",
        had_failures: "true",
      }),
    );
    const agreeingQuery = importsQueryParams("History", agreeing);
    expect(agreeingQuery.get("failure_code")).toBe("E_INGEST_FAILED");
    expect(agreeingQuery.get("had_failures")).toBe("true");
  });

  it("encodes a canonical, stable-ordered URL that decodes back unchanged", () => {
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
    expect(decodeImportsUrlState(encoded)).toEqual(decoded);
  });

  it("encodes nothing for a pane that has not chosen a view", () => {
    const empty: ImportsUrlState = decodeImportsUrlState(new URLSearchParams());
    expect(encodeImportsUrlState(empty, new URLSearchParams()).toString()).toBe(
      "",
    );
  });
});
