import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LibraryDestinationPicker from "./LibraryDestinationPicker";
import {
  searchWritableLibraryDestinations,
  type LibraryDestination,
} from "@/lib/libraries/client";

const research = {
  id: "lib-research",
  name: "Research",
  color: "#0ea5e9",
  created_at: "",
  updated_at: "",
};

const books = {
  id: "lib-books",
  name: "Books",
  color: "#22c55e",
  created_at: "",
  updated_at: "",
};

function Harness({
  initial = [],
  disabled = false,
  onBusyChange,
}: {
  initial?: string[];
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [selectedLibraryIds, setSelectedLibraryIds] = useState(initial);
  return (
    <LibraryDestinationPicker
      selectedLibraryIds={selectedLibraryIds}
      onChange={setSelectedLibraryIds}
      disabled={disabled}
      label="Libraries"
      onBusyChange={onBusyChange}
    />
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pathFor(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, "http://localhost");
  return `${url.pathname}${url.search}`;
}

function parseJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("Expected JSON request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function destinationPage(data: LibraryDestination[]) {
  return { data, page: { next_cursor: null } };
}

function installLibraryFetch({
  search,
  create,
}: {
  search?: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
  create?: (init: RequestInit | undefined) => Response | Promise<Response>;
} = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
            created_at: "",
            updated_at: "",
          },
        },
        201,
      );
    }

    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
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
  await waitFor(() => {
    expect(searchCalls(fetchMock)).toHaveLength(count);
  });
}

async function seedDestinationCache() {
  const fetchMock = installLibraryFetch();
  await searchWritableLibraryDestinations();
  fetchMock.mockClear();
  return fetchMock;
}

function deferredResponse() {
  let resolve: ((value: Response) => void) | undefined;
  const promise = new Promise<Response>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("LibraryDestinationPicker", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads destinations from server search", async () => {
    const fetchMock = installLibraryFetch();

    render(<Harness />);

    fireEvent.focus(screen.getByRole("combobox", { name: "Libraries" }));
    await waitForSearchCallCount(fetchMock);

    expect(await screen.findByRole("option", { name: "Research" })).toBeInTheDocument();
  });

  it("keeps selected chips visible when filtered out", async () => {
    const fetchMock = installLibraryFetch();

    render(<Harness />);

    const input = screen.getByRole("combobox", { name: "Libraries" });
    fireEvent.focus(input);
    await waitForSearchCallCount(fetchMock);
    fireEvent.click(await screen.findByRole("option", { name: "Research" }));
    fireEvent.change(input, { target: { value: "zzzz" } });
    await waitForSearchCallCount(fetchMock, 2);

    expect(screen.getByRole("button", { name: "Remove Research" })).toBeInTheDocument();
  });

  it("creates and auto-selects a new library", async () => {
    const fetchMock = installLibraryFetch();

    render(<Harness />);

    const input = screen.getByRole("combobox", { name: "Libraries" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "New Library" } });
    await waitForSearchCallCount(fetchMock);
    fireEvent.click(await screen.findByRole("option", { name: "Create “New Library”" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Remove New Library" })).toBeInTheDocument();
    });
    const createCall = fetchMock.mock.calls.find(
      ([input, init]) => pathFor(input) === "/api/libraries" && init?.method === "POST",
    );
    expect(parseJsonBody(createCall?.[1])).toEqual({ name: "New Library" });
  });

  it("supports keyboard selection with aria-activedescendant", async () => {
    const fetchMock = installLibraryFetch();

    render(<Harness />);

    const input = screen.getByRole("combobox", { name: "Libraries" });
    fireEvent.focus(input);
    await waitForSearchCallCount(fetchMock);
    await screen.findByRole("option", { name: "Research" });
    await waitFor(() => {
      expect(input).toHaveAttribute("aria-activedescendant");
    });

    fireEvent.keyDown(input, { key: "Enter" });

    expect(input).toHaveAttribute("aria-activedescendant");
    expect(screen.getByRole("listbox", { name: "Libraries" })).toHaveAttribute(
      "aria-multiselectable",
      "true",
    );
    expect(screen.getByRole("option", { name: "Research" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("button", { name: "Remove Research" })).toBeInTheDocument();
  });

  it("does not mutate selection while disabled", async () => {
    await seedDestinationCache();
    const onChange = vi.fn();

    render(
      <LibraryDestinationPicker
        selectedLibraryIds={["lib-research"]}
        onChange={onChange}
        disabled
        label="Libraries"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove Research" }));

    expect(screen.getByRole("combobox", { name: "Libraries" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports create busy state to the parent", async () => {
    const createResponse = deferredResponse();
    const onBusyChange = vi.fn();
    const fetchMock = installLibraryFetch({
      create: () => createResponse.promise,
    });

    render(<Harness onBusyChange={onBusyChange} />);

    const input = screen.getByRole("combobox", { name: "Libraries" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "New Library" } });
    await waitForSearchCallCount(fetchMock);
    fireEvent.click(await screen.findByRole("option", { name: "Create “New Library”" }));

    await waitFor(() => {
      expect(onBusyChange).toHaveBeenLastCalledWith(true);
    });

    await act(async () => {
      createResponse.resolve?.(
        jsonResponse(
          {
            data: {
              id: "lib-created",
              name: "New Library",
              color: null,
              created_at: "",
              updated_at: "",
            },
          },
          201,
        ),
      );
    });

    await waitFor(() => {
      expect(onBusyChange).toHaveBeenLastCalledWith(false);
    });
  });

  it("ignores stale search responses", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    let searchCount = 0;
    const fetchMock = installLibraryFetch({
      search: () => {
        searchCount += 1;
        return searchCount === 1 ? first.promise : second.promise;
      },
    });

    render(<Harness />);

    const input = screen.getByRole("combobox", { name: "Libraries" });
    fireEvent.focus(input);
    await waitForSearchCallCount(fetchMock);
    fireEvent.change(input, { target: { value: "book" } });
    await waitForSearchCallCount(fetchMock, 2);

    await act(async () => {
      second.resolve?.(jsonResponse(destinationPage([books])));
    });
    expect(await screen.findByRole("option", { name: "Books" })).toBeInTheDocument();

    await act(async () => {
      first.resolve?.(jsonResponse(destinationPage([research])));
    });

    await waitFor(() => {
      expect(screen.queryByRole("option", { name: "Research" })).toBeNull();
    });
  });
});
