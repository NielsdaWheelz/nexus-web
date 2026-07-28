import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState, type ReactNode } from "react";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import LibraryDestinationPicker from "./LibraryDestinationPicker";
import type { LibraryDestinationSelection } from "@/lib/libraries/client";

function destinationRow(id: string, name: string) {
  return {
    id,
    name,
    color: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function pageOf(
  rows: ReturnType<typeof destinationRow>[],
  nextCursor: string | null = null,
): Response {
  return new Response(
    JSON.stringify({
      data: rows,
      page: { has_more: nextCursor !== null, next_cursor: nextCursor },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function queryParam(input: RequestInfo | URL): {
  path: string;
  q: string;
  cursor: string | null;
} {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, "http://localhost");
  return {
    path: url.pathname,
    q: url.searchParams.get("q") ?? "",
    cursor: url.searchParams.get("cursor"),
  };
}

function Harness({
  initialSelected = [],
  onCreate,
}: {
  initialSelected?: readonly LibraryDestinationSelection[];
  onCreate?: (name: string) => Promise<LibraryDestinationSelection>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] =
    useState<readonly LibraryDestinationSelection[]>(initialSelected);
  const [creating, setCreating] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={anchorRef} type="button" onClick={() => setOpen((o) => !o)}>
        Toggle
      </button>
      <LibraryDestinationPicker
        open={open}
        onClose={() => setOpen(false)}
        anchor={() => anchorRef.current}
        layer="modal"
        title="Library destinations"
        selectedGroupLabel="Selected"
        selected={selected}
        onChange={setSelected}
        interaction={creating ? { kind: "Creating" } : { kind: "Enabled" }}
        onCreateDestination={async (name) => {
          setCreating(true);
          try {
            return onCreate
              ? await onCreate(name)
              : { id: `created-${name}`, name, color: null };
          } finally {
            setCreating(false);
          }
        }}
      />
    </div>
  );
}

function renderPicker(node: ReactNode) {
  return render(withRenderEnvironment(node));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LibraryDestinationPicker", () => {
  it("issues an immediate search on open and renders results as options", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const { path } = queryParam(input);
      if (path === "/api/libraries/writable-destinations") {
        return pageOf([destinationRow("a", "Reading"), destinationRow("b", "Watchlist")]);
      }
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPicker(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));

    expect(await screen.findByRole("option", { name: "Reading" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Watchlist" })).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          queryParam(input).path === "/api/libraries/writable-destinations",
      ),
    ).toBe(true);
  });

  it("shows selected in the Selected group and subtracts them from Other libraries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        pageOf([destinationRow("a", "Reading"), destinationRow("b", "Watchlist")]),
      ),
    );

    renderPicker(
      <Harness initialSelected={[{ id: "a", name: "Reading", color: null }]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));

    // Reading appears exactly once (in the Selected group, selected), not duplicated in Other.
    await screen.findByRole("option", { name: "Watchlist" });
    const reading = screen.getAllByRole("option", { name: "Reading" });
    expect(reading).toHaveLength(1);
    expect(reading[0]).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("option", { name: "Watchlist" }),
    ).toHaveAttribute("aria-selected", "false");
  });

  it("toggles a destination into the selection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pageOf([destinationRow("b", "Watchlist")])),
    );

    renderPicker(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));

    const option = await screen.findByRole("option", { name: "Watchlist" });
    fireEvent.click(option);
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: "Watchlist" }),
      ).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("offers a Create row for a valid unmatched name and creates it", async () => {
    const onCreate = vi.fn(async (name: string) => ({
      id: "new-1",
      name,
      color: null,
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { path, q } = queryParam(input);
      if (path === "/api/libraries/writable-destinations") {
        return q === "" ? pageOf([destinationRow("a", "Reading")]) : pageOf([]);
      }
      throw new Error(`unexpected ${(init?.method ?? "GET")} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPicker(<Harness onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    await screen.findByRole("option", { name: "Reading" });

    fireEvent.change(
      screen.getByRole("combobox", { name: "Search or create a library" }),
      { target: { value: "Fresh" } },
    );
    fireEvent.click(await screen.findByText("Create “Fresh”"));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Fresh"));
  });

  it("appends a further page via Load more", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const { cursor } = queryParam(input);
      return cursor === null
        ? pageOf([destinationRow("a", "Reading")], "cursor-2")
        : pageOf([destinationRow("b", "Watchlist")]);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPicker(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    await screen.findByRole("option", { name: "Reading" });

    fireEvent.click(screen.getByText("Load more libraries"));
    expect(await screen.findByRole("option", { name: "Watchlist" })).toBeInTheDocument();
  });

  it("preserves the last results across close and reopen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pageOf([destinationRow("a", "Reading")])),
    );

    renderPicker(<Harness />);
    const toggle = screen.getByRole("button", { name: "Toggle" });
    fireEvent.click(toggle);
    await screen.findByRole("option", { name: "Reading" });

    fireEvent.click(toggle); // close
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: "Reading" })).toBeNull(),
    );

    fireEvent.click(toggle); // reopen
    expect(await screen.findByRole("option", { name: "Reading" })).toBeInTheDocument();
  });
});
