import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Component, useEffect, useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import type { AddSeed, LauncherActionTarget } from "@/lib/launcher/model";
import AddPanel, { type AddDismissalConfirmation } from "./AddPanel";
import { useAddContentSession } from "./useAddContentSession";

const CONTENT_SEED: AddSeed = {
  kind: "Content",
  initialFocus: "Url",
  initialDestinations: [],
};

class DefectBoundary extends Component<
  { children: ReactNode; onDefect: (error: unknown) => void },
  { error: unknown | null }
> {
  state: { error: unknown | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    this.props.onDefect(error);
  }

  render() {
    return this.state.error ? <p>Add defect boundary</p> : this.props.children;
  }
}

function Harness({
  seed = CONTENT_SEED,
  confirmation = null,
  onBack = vi.fn(),
  onClose = vi.fn(),
  onOpen = vi.fn(),
  onDefect = vi.fn(),
}: {
  seed?: AddSeed;
  confirmation?: AddDismissalConfirmation;
  onBack?: () => void;
  onClose?: () => void;
  onOpen?: (target: LauncherActionTarget) => void;
  onDefect?: (error: unknown) => void;
}) {
  const session = useAddContentSession();
  const { start } = session;
  useEffect(() => start(seed), [seed, start]);
  return (
    <AddPanel
      session={session}
      dismissalConfirmation={confirmation}
      onBack={onBack}
      onClose={onClose}
      onOpen={onOpen}
      onKeepWorking={vi.fn()}
      onConfirmDismissal={vi.fn()}
      onDefect={onDefect}
    />
  );
}

function renderPanel(props: React.ComponentProps<typeof Harness> = {}) {
  return render(withRenderEnvironment(<Harness {...props} />));
}

function DefectOwner() {
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  if (defect) throw defect.error;
  return <Harness onDefect={(error) => setDefect({ error })} />;
}

beforeEach(() => {
  vi.stubGlobal("innerWidth", 1280);
});

describe("AddPanel source-first workbench", () => {
  it("reviews links locally and exposes one explicit batch submit", async () => {
    renderPanel();
    const links = await screen.findByRole("textbox", { name: "Links" });
    const file = screen.getByRole("button", { name: "Choose PDF or EPUB" });
    const libraries = screen.getByRole("button", {
      name: /Libraries My Library only Change/,
    });
    const opml = screen.getByRole("button", {
      name: "Import podcast subscriptions from OPML",
    });

    expect(
      links.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      file.compareDocumentPosition(libraries) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      libraries.compareDocumentPosition(opml) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.change(links, {
      target: { value: "https://example.com/one\nhttps://example.com/two" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review links" }));

    const queue = await screen.findByLabelText("Items to add");
    expect(
      within(queue).getByText("https://example.com/one"),
    ).toBeInTheDocument();
    expect(
      within(queue).getByText("https://example.com/two"),
    ).toBeInTheDocument();
    expect(within(queue).getAllByText("Ready to add")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Add 2 items" }),
    ).toBeInTheDocument();
  });

  it("rejects a staging action over the 20-item cap atomically and retains the raw input", async () => {
    renderPanel();
    const links = await screen.findByRole("textbox", { name: "Links" });
    const value = Array.from(
      { length: 21 },
      (_, index) => `https://example.com/${index}`,
    ).join("\n");
    fireEvent.change(links, { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Review links" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Add up to 20 items at a time.",
    );
    expect(links).toHaveValue(value);
    expect(screen.queryByLabelText("Items to add")).not.toBeInTheDocument();
  });

  it("stages valid and invalid files without submitting either", async () => {
    renderPanel();
    const input = await screen.findByLabelText("Choose PDF or EPUB files");
    const valid = new File(["pdf"], "brief.pdf", { type: "application/pdf" });
    const invalid = new File(["text"], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [valid, invalid] } });

    const queue = await screen.findByLabelText("Items to add");
    expect(within(queue).getByText("brief.pdf")).toBeInTheDocument();
    expect(within(queue).getByText("notes.txt")).toBeInTheDocument();
    expect(
      within(queue).getByText("Only PDF and EPUB files are supported."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add 1 item" }),
    ).toBeInTheDocument();
  });

  it("returns focus to Links after removing the last focused row", async () => {
    renderPanel();
    fireEvent.change(await screen.findByRole("textbox", { name: "Links" }), {
      target: { value: "https://example.com/only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review links" }));

    const remove = await screen.findByRole("button", {
      name: "Remove https://example.com/only",
    });
    remove.focus();
    expect(remove).toHaveFocus();
    fireEvent.click(remove);

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Links" })).toHaveFocus(),
    );
    expect(screen.queryByLabelText("Items to add")).not.toBeInTheDocument();
  });

  it("renders OPML as a secondary branch with local file validation", async () => {
    renderPanel({ seed: { kind: "Opml", initialDestinations: [] } });
    expect(
      await screen.findByRole("heading", { name: "Import OPML" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Libraries for new subscriptions No libraries selected Change/,
      }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Choose OPML file"), {
      target: {
        files: [new File(["text"], "feeds.txt", { type: "text/plain" })],
      },
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Choose an OPML or XML file.",
    );
    expect(screen.getByRole("button", { name: "Import OPML" })).toBeDisabled();
  });

  it("projects the complete OPML result and opens podcast management explicitly", async () => {
    const onOpen = vi.fn();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input), "http://localhost");
        expect(url.pathname).toBe("/api/podcasts/import/opml");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          opml: "<opml><body /></opml>",
          default_library_ids: [],
          per_feed_library_ids: {},
        });
        return new Response(
          JSON.stringify({
            data: {
              total: 7,
              imported: 2,
              skipped_already_subscribed: 1,
              skipped_invalid: 1,
              errors: [
                {
                  feed_url: "https://feeds.example/broken.xml",
                  error: "Feed unavailable",
                },
              ],
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      });

    try {
      renderPanel({
        seed: { kind: "Opml", initialDestinations: [] },
        onOpen,
      });
      fireEvent.change(await screen.findByLabelText("Choose OPML file"), {
        target: {
          files: [
            new File(["<opml><body /></opml>"], "subscriptions.opml", {
              type: "text/xml",
            }),
          ],
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "Import OPML" }));

      const region = await screen.findByRole("region", {
        name: "Import summary",
      });
      expect(
        within(region)
          .getAllByRole("term")
          .map((term) => term.textContent),
      ).toEqual([
        "Total",
        "Imported",
        "Already subscribed",
        "Invalid",
        "Could not subscribe",
      ]);
      expect(
        within(region)
          .getAllByRole("definition")
          .map((definition) => definition.textContent),
      ).toEqual(["7", "2", "1", "1", "3"]);
      expect(
        within(region).getByRole("heading", { name: "Issues" }),
      ).toBeInTheDocument();
      expect(region).toHaveTextContent(
        "https://feeds.example/broken.xml: Feed unavailable",
      );
      expect(
        screen.queryByLabelText("Choose OPML file"),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Import complete: 7 total, 2 imported, 1 already subscribed, 1 invalid, 3 could not subscribe.",
      );

      fireEvent.click(
        within(region).getByRole("button", { name: "Manage podcasts" }),
      );
      expect(onOpen).toHaveBeenCalledWith({
        kind: "href",
        href: "/podcasts",
        externalShell: false,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("announces a modeled OPML import failure in the single polite region", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "E_INVALID_REQUEST",
            message: "The OPML document is malformed.",
            request_id: "req-opml-invalid",
          },
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    );

    try {
      renderPanel({ seed: { kind: "Opml", initialDestinations: [] } });
      fireEvent.change(await screen.findByLabelText("Choose OPML file"), {
        target: {
          files: [new File(["<opml>"], "broken.opml", { type: "text/xml" })],
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "Import OPML" }));

      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent(
          "OPML could not be imported. Request ID: req-opml-invalid",
        ),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("replaces actions with an explicit Stop confirmation while work is active", async () => {
    renderPanel({
      confirmation: { kind: "Stop", actionLabel: "Stop and close" },
    });
    const confirmation = await screen.findByRole("dialog", {
      name: "Stop active work?",
    });
    expect(
      within(confirmation).getByRole("button", { name: "Keep working" }),
    ).toBeInTheDocument();
    expect(
      within(confirmation).getByRole("button", { name: "Stop and close" }),
    ).toBeInTheDocument();
  });

  it("bridges a rejected session defect to the owner error boundary", async () => {
    const onDefect = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: {} }), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    try {
      render(
        withRenderEnvironment(
          <DefectBoundary onDefect={onDefect}>
            <DefectOwner />
          </DefectBoundary>,
        ),
      );
      fireEvent.change(await screen.findByRole("textbox", { name: "Links" }), {
        target: { value: "https://example.com/defect" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Review links" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Add 1 item" }),
      );

      expect(
        await screen.findByText("Add defect boundary"),
      ).toBeInTheDocument();
      expect(onDefect).toHaveBeenCalledWith(
        expect.objectContaining({ name: "MediaIngestionContractDefect" }),
      );
    } finally {
      fetchSpy.mockRestore();
      consoleError.mockRestore();
    }
  });
});
