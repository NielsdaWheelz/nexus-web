import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import { fetchInputPath, jsonResponse, stubFetch } from "@/__tests__/helpers/fetch";
import LibraryIntelligencePane from "./LibraryIntelligencePane";

const LIBRARY_ID = "ac5-library";

function readyArtifact() {
  return {
    artifact_id: "artifact-1",
    artifact_ref: "library_intelligence_artifact:artifact-1",
    revision_id: "revision-1",
    revision_ref: "library_intelligence_revision:revision-1",
    status: "current",
    content_md: "Grounded synthesis body.",
    citations: [],
    stale_source_count: null,
    citation_count: 0,
    source_count: 3,
    covered_source_count: 3,
    omitted_source_count: 0,
    custom_instruction: null,
    model_provider: "anthropic",
    model_name: "claude-test",
    total_tokens: 100,
    build: null,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LibraryIntelligencePane (Machine Hand AC-5)", () => {
  it("sets the dossier body in the machine register with a DOSSIER signature and no timestamp", async () => {
    stubFetch(async (input) => {
      if (fetchInputPath(input) === `/api/libraries/${LIBRARY_ID}/intelligence`) {
        return jsonResponse({ data: readyArtifact() });
      }
      return jsonResponse({});
    });

    renderHydratedPane({
      href: `/libraries/${LIBRARY_ID}`,
      resources: {},
      children: <LibraryIntelligencePane libraryId={LIBRARY_ID} />,
    });

    const body = await screen.findByText("Grounded synthesis body.");
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: asserting the dossier prose renders INSIDE the machine wrapper; the wrapper carries a data-provenance attribute, not a role/label
    const machine = document.querySelector('[data-machine-origin="Dossier"]');
    expect(machine).not.toBeNull();
    // The dossier prose is inside the machine block, signed DOSSIER…
    expect(machine).toContainElement(body);
    expect(machine).toContainElement(screen.getByText("Dossier", { selector: "span" }));
    // …with NO timestamp (the StatusLine already prints the generated time).
    expect(screen.queryByText(/^·/)).not.toBeInTheDocument();

    // The status line stays outside the machine register (human sans).
    const statusLabel = screen.getByText("Current");
    // eslint-disable-next-line testing-library/no-node-access -- justify-eslint-override: asserting the status line has NO machine-origin ancestor
    expect(statusLabel.closest("[data-machine-origin]")).toBeNull();
  });
});
