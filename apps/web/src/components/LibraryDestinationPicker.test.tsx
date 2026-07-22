import { Component, useState, type ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import {
  createLibrary,
  type LibraryDestination,
  type LibraryDestinationSelection,
} from "@/lib/libraries/client";
import LibraryDestinationPicker from "./LibraryDestinationPicker";

const research: LibraryDestination = {
  id: "lib-research",
  name: "Research",
  color: "#0ea5e9",
  created_at: "2026-07-21T12:00:00Z",
  updated_at: "2026-07-21T12:00:00Z",
};

const books: LibraryDestination = {
  id: "lib-books",
  name: "Books",
  color: "#22c55e",
  created_at: "2026-07-21T12:00:00Z",
  updated_at: "2026-07-21T12:00:00Z",
};

const archive: LibraryDestination = {
  id: "lib-archive",
  name: "Archive",
  color: "#f97316",
  created_at: "2026-07-21T12:00:00Z",
  updated_at: "2026-07-21T12:00:00Z",
};

function Harness({
  initial = [],
  onCreateDestination = async (name) => ({ id: "created", name, color: null }),
}: {
  initial?: readonly LibraryDestinationSelection[];
  onCreateDestination?: (name: string) => Promise<LibraryDestinationSelection>;
}) {
  const [selected, setSelected] = useState(initial);
  return (
    <LibraryDestinationPicker
      selected={selected}
      onChange={setSelected}
      presentation={{ kind: "Inline" }}
      label="Libraries"
      interaction={{ kind: "Enabled" }}
      onCreateDestination={onCreateDestination}
    />
  );
}

function CreatingHarness({
  create,
}: {
  create(name: string): Promise<LibraryDestinationSelection>;
}) {
  const [selected, setSelected] = useState<
    readonly LibraryDestinationSelection[]
  >([]);
  const [creating, setCreating] = useState(false);
  return (
    <LibraryDestinationPicker
      selected={selected}
      onChange={setSelected}
      presentation={{ kind: "Inline" }}
      label="Libraries"
      interaction={creating ? { kind: "Creating" } : { kind: "Enabled" }}
      onCreateDestination={async (name) => {
        setCreating(true);
        try {
          return await create(name);
        } finally {
          window.setTimeout(() => setCreating(false), 0);
        }
      }}
    />
  );
}

class DefectBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <div role="alert">Defect surfaced</div>
    ) : (
      this.props.children
    );
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string): Response {
  return jsonResponse(
    { error: { code, message: code, request_id: `req-${code}` } },
    status,
  );
}

function pathFor(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, "http://localhost");
  return `${url.pathname}${url.search}`;
}

function parseJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function destinationPage(
  data: LibraryDestination[],
  nextCursor: string | null = null,
) {
  return {
    data,
    page: { has_more: nextCursor !== null, next_cursor: nextCursor },
  };
}

function installLibraryFetch({
  search,
  create,
}: {
  search?: (
    url: URL,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>;
  create?: (init: RequestInit | undefined) => Response | Promise<Response>;
} = {}) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = pathFor(input);
      const url = new URL(path, "http://localhost");
      const method = init?.method ?? "GET";

      if (url.pathname === "/api/libraries/writable-destinations") {
        if (search) return search(url, init);
        const query = (url.searchParams.get("q") ?? "").trim();
        return jsonResponse(destinationPage(query ? [] : [research, books]));
      }

      if (url.pathname === "/api/libraries" && method === "POST") {
        if (create) return create(init);
        const body = parseJsonBody(init);
        return jsonResponse(
          {
            data: {
              id: "lib-created",
              name: String(body.name),
              color: null,
              created_at: "2026-07-21T12:00:00Z",
              updated_at: "2026-07-21T12:00:00Z",
            },
          },
          201,
        );
      }

      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  return fetchMock;
}

function searchCalls(fetchMock: ReturnType<typeof installLibraryFetch>) {
  return fetchMock.mock.calls.filter(
    ([input]) =>
      new URL(pathFor(input), "http://localhost").pathname ===
      "/api/libraries/writable-destinations",
  );
}

async function waitForSearchCallCount(
  fetchMock: ReturnType<typeof installLibraryFetch>,
  count = 1,
) {
  await waitFor(() => expect(searchCalls(fetchMock)).toHaveLength(count));
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => vi.restoreAllMocks());

describe("LibraryDestinationPicker", () => {
  it("projects selected destination objects and removes one without opening search", () => {
    render(<Harness initial={[research]} />);

    expect(screen.getByText("Research")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Research" }));

    expect(screen.queryByText("Research")).not.toBeInTheDocument();
    expect(screen.getByText("My Library only")).toBeInTheDocument();
  });

  it("keeps selected objects visible but prevents mutation while disabled", () => {
    const onChange = vi.fn();
    render(
      <LibraryDestinationPicker
        selected={[research]}
        onChange={onChange}
        presentation={{ kind: "Inline" }}
        label="Libraries"
        interaction={{ kind: "Disabled" }}
        onCreateDestination={async () => research}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove Research" }));

    expect(screen.getByRole("combobox", { name: "Libraries" })).toBeDisabled();
    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("associates ordinary status text with the combobox without a live region", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "Libraries" });

    expect(input).toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("loads the initial writable destinations through the fetch boundary", async () => {
    const fetchMock = installLibraryFetch();
    render(<Harness />);

    fireEvent.focus(screen.getByRole("combobox", { name: "Libraries" }));
    expect(
      await screen.findByRole("option", { name: "Research" }),
    ).toBeInTheDocument();

    expect(searchCalls(fetchMock)).toHaveLength(1);
    expect(pathFor(searchCalls(fetchMock)[0]![0])).toBe(
      "/api/libraries/writable-destinations?limit=25",
    );
    expect(searchCalls(fetchMock)[0]![1]).toEqual(
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("loads the next opaque-cursor page", async () => {
    const fetchMock = installLibraryFetch({
      search: (url) =>
        jsonResponse(
          url.searchParams.get("cursor") === "cursor-2"
            ? destinationPage([archive])
            : destinationPage([research], "cursor-2"),
        ),
    });
    render(<Harness />);

    fireEvent.focus(screen.getByRole("combobox", { name: "Libraries" }));
    expect(
      await screen.findByRole("option", { name: "Research" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("option", { name: "Load more libraries" }),
    );

    expect(
      await screen.findByRole("option", { name: "Archive" }),
    ).toBeInTheDocument();
    expect(pathFor(searchCalls(fetchMock)[1]![0])).toBe(
      "/api/libraries/writable-destinations?cursor=cursor-2&limit=25",
    );
  });

  it("ignores a stale initial search response after the query changes", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    let requestCount = 0;
    const fetchMock = installLibraryFetch({
      search: () => {
        requestCount += 1;
        return requestCount === 1 ? first.promise : second.promise;
      },
    });
    render(<Harness />);

    const input = screen.getByRole("combobox", { name: "Libraries" });
    fireEvent.focus(input);
    await waitForSearchCallCount(fetchMock);
    fireEvent.change(input, { target: { value: "fresh" } });
    await waitForSearchCallCount(fetchMock, 2);

    await act(async () => {
      second.resolve(jsonResponse(destinationPage([archive])));
      await second.promise;
    });
    expect(
      await screen.findByRole("option", { name: "Archive" }),
    ).toBeInTheDocument();

    await act(async () => {
      first.resolve(jsonResponse(destinationPage([research])));
      await first.promise;
    });
    expect(screen.queryByRole("option", { name: "Research" })).toBeNull();
  });

  it("ignores a stale page after a new search starts", async () => {
    const stalePage = deferredResponse();
    const fetchMock = installLibraryFetch({
      search: (url) => {
        if (url.searchParams.get("cursor") === "cursor-2") {
          return stalePage.promise;
        }
        if (url.searchParams.get("q") === "zz") {
          return jsonResponse(destinationPage([]));
        }
        return jsonResponse(destinationPage([research], "cursor-2"));
      },
    });
    render(<Harness />);

    const input = screen.getByRole("combobox", { name: "Libraries" });
    fireEvent.focus(input);
    expect(
      await screen.findByRole("option", { name: "Research" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("option", { name: "Load more libraries" }),
    );
    await waitForSearchCallCount(fetchMock, 2);
    fireEvent.change(input, { target: { value: "zz" } });
    await waitForSearchCallCount(fetchMock, 3);

    await act(async () => {
      stalePage.resolve(jsonResponse(destinationPage([archive])));
      await stalePage.promise;
    });
    expect(screen.queryByRole("option", { name: "Archive" })).toBeNull();
  });

  it("tracks and selects the keyboard-active option", async () => {
    installLibraryFetch();
    render(<Harness />);

    const input = screen.getByRole("combobox", { name: "Libraries" });
    fireEvent.focus(input);
    const first = await screen.findByRole("option", { name: "Research" });
    const second = screen.getByRole("option", { name: "Books" });
    await waitFor(() =>
      expect(input).toHaveAttribute("aria-activedescendant", first.id),
    );

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", second.id);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      screen.getByRole("button", { name: "Remove Books" }),
    ).toBeInTheDocument();
    expect(second).toHaveAttribute("aria-selected", "true");
  });

  it("creates and auto-selects a strictly decoded destination", async () => {
    const fetchMock = installLibraryFetch();
    render(
      <Harness onCreateDestination={async (name) => createLibrary({ name })} />,
    );

    const input = screen.getByRole("combobox", { name: "Libraries" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "New Library" } });
    fireEvent.click(
      await screen.findByRole("option", { name: "Create “New Library”" }),
    );

    expect(
      await screen.findByRole("button", { name: "Remove New Library" }),
    ).toBeInTheDocument();
    const createCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        pathFor(input) === "/api/libraries" && init?.method === "POST",
    );
    expect(parseJsonBody(createCall?.[1])).toEqual({ name: "New Library" });
  });

  it("restores focus after Creating rerenders as Enabled", async () => {
    let resolveCreate!: (value: LibraryDestinationSelection) => void;
    const creation = new Promise<LibraryDestinationSelection>((resolve) => {
      resolveCreate = resolve;
    });
    installLibraryFetch();
    render(<CreatingHarness create={() => creation} />);

    const input = screen.getByRole("combobox", { name: "Libraries" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "New Library" } });
    fireEvent.click(
      await screen.findByRole("option", { name: "Create “New Library”" }),
    );
    await waitFor(() => expect(input).toBeDisabled());

    await act(async () => {
      resolveCreate({ id: "lib-created", name: "New Library", color: null });
      await creation;
    });

    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Remove New Library" }),
    ).toBeInTheDocument();
  });

  it("clears aria-activedescendant while a new search hides its option", async () => {
    installLibraryFetch();
    render(<Harness initial={[research]} />);
    const input = screen.getByRole("combobox", { name: "Libraries" });
    fireEvent.focus(input);
    await waitFor(() => expect(input).toHaveAttribute("aria-activedescendant"));

    fireEvent.change(input, { target: { value: "new query" } });

    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("surfaces a same-system search defect instead of product feedback", async () => {
    installLibraryFetch({ search: () => errorResponse(500, "E_INTERNAL") });
    render(
      <DefectBoundary>
        <Harness />
      </DefectBoundary>,
    );

    fireEvent.focus(screen.getByRole("combobox", { name: "Libraries" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Defect surfaced",
    );
    expect(screen.queryByText("E_INTERNAL")).not.toBeInTheDocument();
  });

  it("surfaces a same-system create defect instead of product feedback", async () => {
    installLibraryFetch();
    render(
      <DefectBoundary>
        <Harness
          onCreateDestination={() =>
            Promise.reject(
              new ApiError(500, "E_INTERNAL", "Create contract failed"),
            )
          }
        />
      </DefectBoundary>,
    );
    const input = screen.getByRole("combobox", { name: "Libraries" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "New Library" } });
    fireEvent.click(
      await screen.findByRole("option", { name: "Create “New Library”" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Defect surfaced",
    );
    expect(
      screen.queryByText("Create contract failed"),
    ).not.toBeInTheDocument();
  });

  it("surfaces a malformed search success as a schema defect", async () => {
    installLibraryFetch({
      search: () =>
        jsonResponse({
          data: [{ ...research, id: 42 }],
          page: { has_more: false, next_cursor: null },
        }),
    });
    render(
      <DefectBoundary>
        <Harness />
      </DefectBoundary>,
    );

    fireEvent.focus(screen.getByRole("combobox", { name: "Libraries" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Defect surfaced",
    );
    expect(
      screen.queryByText(/Invalid library destination response/),
    ).not.toBeInTheDocument();
  });

  it("surfaces a malformed create success as a schema defect", async () => {
    installLibraryFetch({
      create: () =>
        jsonResponse(
          {
            data: {
              id: 42,
              name: "New Library",
              color: null,
              created_at: "2026-07-21T12:00:00Z",
              updated_at: "2026-07-21T12:00:00Z",
            },
          },
          201,
        ),
    });
    render(
      <DefectBoundary>
        <Harness
          onCreateDestination={async (name) => createLibrary({ name })}
        />
      </DefectBoundary>,
    );
    const input = screen.getByRole("combobox", { name: "Libraries" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "New Library" } });
    fireEvent.click(
      await screen.findByRole("option", { name: "Create “New Library”" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Defect surfaced",
    );
    expect(
      screen.queryByText(/Invalid library destination response/),
    ).not.toBeInTheDocument();
  });

  it("silently ignores a create aborted by the owning session", async () => {
    let rejectCreate!: (reason: unknown) => void;
    const creation = new Promise<LibraryDestinationSelection>(
      (_resolve, reject) => {
        rejectCreate = reject;
      },
    );
    installLibraryFetch();
    render(<Harness onCreateDestination={() => creation} />);
    const input = screen.getByRole("combobox", { name: "Libraries" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "New Library" } });
    fireEvent.click(
      await screen.findByRole("option", { name: "Create “New Library”" }),
    );

    await act(async () => {
      rejectCreate(new DOMException("Session replaced", "AbortError"));
      await creation.catch(() => undefined);
    });

    expect(
      screen.getByRole("option", { name: "Create “New Library”" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Session replaced")).not.toBeInTheDocument();
  });
});
