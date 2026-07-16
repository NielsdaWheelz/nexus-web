import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MediaAuthorsEditor, { type MediaAuthorsEditorProps } from "./MediaAuthorsEditor";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { assumeContributorHandle } from "@/lib/contributors/handle";
import type { ContributorSearchItem, MediaAuthorCredit } from "@/lib/contributors/types";

interface PutBody {
  clientMutationId: string;
  mode: "manual" | "automatic";
  authors?: Array<{
    creditedName: string;
    binding: { kind: "existing"; contributorHandle: string } | { kind: "new"; displayName: string };
  }>;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string, requestId = "req-x"): Response {
  return new Response(JSON.stringify({ error: { code, message: code, request_id: requestId } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "new-author";
}

function defaultPutResult(body: PutBody): unknown {
  const authors =
    body.mode === "manual" && body.authors
      ? body.authors.map((row) => {
          const handle =
            row.binding.kind === "existing" ? row.binding.contributorHandle : slug(row.binding.displayName);
          const displayName = row.binding.kind === "existing" ? row.creditedName : row.binding.displayName;
          return { contributorHandle: handle, href: `/authors/${handle}`, displayName, creditedName: row.creditedName };
        })
      : [];
  return { data: { authorMode: body.mode, canEditAuthors: true, authors } };
}

function installFetch(opts: { put?: (body: PutBody) => Response; searchItems?: ContributorSearchItem[] } = {}) {
  const calls: Array<{ method: string; url: string; body?: PutBody }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as PutBody) : undefined;
    calls.push({ method, url: String(url), body });
    if (method === "PUT") {
      return opts.put ? opts.put(body!) : jsonResponse(defaultPutResult(body!));
    }
    return jsonResponse({ data: { contributors: opts.searchItems ?? [], nextCursor: null } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const puts = () => calls.filter((call) => call.method === "PUT");
  return { fetchMock, calls, puts };
}

function author(handle: string, name: string, credited = name): MediaAuthorCredit {
  return {
    contributorHandle: assumeContributorHandle(handle),
    href: `/authors/${handle}`,
    displayName: name,
    creditedName: credited,
  };
}

const BASE_AUTHORS: MediaAuthorCredit[] = [
  author("ursula-le-guin", "Ursula K. Le Guin"),
  author("brian-attebery", "Brian Attebery"),
];

function searchItem(handle: string, name: string): ContributorSearchItem {
  return {
    handle: assumeContributorHandle(handle),
    href: `/authors/${handle}`,
    displayName: name,
    workCount: 1,
    workExamples: [],
    matchedAlias: null,
  };
}

function renderEditor(
  overrides: Partial<MediaAuthorsEditorProps> = {},
  env: Parameters<typeof withRenderEnvironment>[1] = {},
) {
  const props: MediaAuthorsEditorProps = {
    open: true,
    mediaId: "media-1",
    authors: BASE_AUTHORS,
    authorMode: "automatic",
    onClose: vi.fn(),
    onSaved: vi.fn(),
    ...overrides,
  };
  const utils = render(
    withRenderEnvironment(
      <FeedbackProvider>
        <MediaAuthorsEditor {...props} />
      </FeedbackProvider>,
      env,
    ),
  );
  return { ...utils, props };
}

// Force the mobile branch: the render-environment `initialViewport` seeds the
// first paint, but the provider's matchMedia effect can flip it — pin matchMedia
// to report mobile so `useIsMobileViewport()` stays true (MobileSheet branch).
function setMobileViewport() {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query.includes("max-width"),
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() {
          return false;
        },
      }) as MediaQueryList,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MediaAuthorsEditor", () => {
  it("renders the dialog with title, helper and seeded rows", () => {
    installFetch();
    renderEditor();
    expect(screen.getByRole("dialog", { name: "Edit authors" })).toBeInTheDocument();
    expect(screen.getByText(/Your changes apply to this work/)).toBeInTheDocument();
    const inputs = screen.getAllByLabelText("Credited as");
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toHaveValue("Ursula K. Le Guin");
    expect(screen.getByText("Brian Attebery")).toBeInTheDocument();
  });

  it("keeps Save disabled when unchanged and performs no PUT on close (AC 16)", () => {
    const { puts } = installFetch();
    const { props } = renderEditor();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClose).toHaveBeenCalled();
    expect(puts()).toHaveLength(0);
  });

  it("enables Save on an edit and PUTs a manual slice, then closes and toasts", async () => {
    const { puts } = installFetch();
    const { props } = renderEditor();
    fireEvent.change(screen.getAllByLabelText("Credited as")[0]!, { target: { value: "U. K. Le Guin" } });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
    const body = puts()[0]!.body!;
    expect(body.mode).toBe("manual");
    expect(body.authors?.[0]).toEqual({
      creditedName: "U. K. Le Guin",
      binding: { kind: "existing", contributorHandle: "ursula-le-guin" },
    });
    expect(props.onClose).toHaveBeenCalled();
    expect(await screen.findByText("Authors saved.")).toBeInTheDocument();
  });

  it("treats an empty save as valid (PUTs authors: [])", async () => {
    const { puts } = installFetch();
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Remove Ursula K. Le Guin" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Brian Attebery" }));
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body!.authors).toEqual([]);
  });

  it("announces a reorder with the position template", async () => {
    installFetch();
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Move Ursula K. Le Guin down" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Moved Ursula K. Le Guin to position 2 of 2",
      ),
    );
  });

  it("moves focus to the next row and announces the count after Remove", async () => {
    installFetch();
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Remove Ursula K. Le Guin" }));
    await waitFor(() => expect(screen.getByLabelText("Credited as")).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent("Removed Ursula K. Le Guin. 1 author.");
  });

  it("disables Add author at the 20-author cap and shows the limit copy", () => {
    installFetch();
    const many: MediaAuthorCredit[] = Array.from({ length: 20 }, (_, i) =>
      author(`author-${i}`, `Author ${i}`),
    );
    renderEditor({ authors: many });
    expect(screen.getByText("A work can have up to 20 authors.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add author/ })).toBeDisabled();
  });

  it("runs the dirty guard: Discard changes? — Keep editing stays, Discard closes", () => {
    installFetch();
    const { props } = renderEditor();
    fireEvent.change(screen.getAllByLabelText("Credited as")[0]!, { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the pinned marker and resets to automatic with a toast", async () => {
    const { puts } = installFetch();
    const { props } = renderEditor({ authorMode: "manual" });
    expect(screen.getByText("Authors edited manually")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset to automatic authors" }));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
    const body = puts()[0]!.body!;
    expect(body.mode).toBe("automatic");
    expect(body.authors).toBeUndefined();
    expect(props.onClose).toHaveBeenCalled();
    expect(
      await screen.findByText("Automatic author updates will resume on the next refresh."),
    ).toBeInTheDocument();
  });

  it("renders the shared 422 title in-dialog and preserves the draft", async () => {
    installFetch({ put: () => errorResponse(422, "E_AUTHOR_ALREADY_LISTED", "req-422") });
    const { props } = renderEditor();
    const input = screen.getAllByLabelText("Credited as")[0]!;
    fireEvent.change(input, { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("That author is already listed for this role.")).toBeInTheDocument();
    expect(input).toHaveValue("Edited");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("shows the transport copy, reuses the same clientMutationId on retry, keeps the draft (AC 28)", async () => {
    const { puts } = installFetch({
      put: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const { props } = renderEditor();
    const input = screen.getAllByLabelText("Credited as")[0]!;
    fireEvent.change(input, { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Couldn't confirm the change. Try again.")).toBeInTheDocument();
    await waitFor(() => expect(puts()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]!.body!.clientMutationId).toBe(puts()[0]!.body!.clientMutationId);
    expect(input).toHaveValue("Edited");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("rotates the clientMutationId after a 409 replay mismatch", async () => {
    const { puts } = installFetch({
      put: () => errorResponse(409, "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH", "req-409"),
    });
    renderEditor();
    fireEvent.change(screen.getAllByLabelText("Credited as")[0]!, { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("That author change changed. Reload and try again.")).toBeInTheDocument();
    await waitFor(() => expect(puts()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]!.body!.clientMutationId).not.toBe(puts()[0]!.body!.clientMutationId);
  });

  it("adds an existing author through the combobox and includes it on Save", async () => {
    const { puts } = installFetch({ searchItems: [searchItem("octavia-butler", "Octavia E. Butler")] });
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Add author" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "oct" } });
    fireEvent.click(await screen.findByRole("option", { name: /Octavia E\. Butler/ }));
    await waitFor(() => expect(screen.getAllByLabelText("Credited as")).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const bindings = puts()[0]!.body!.authors!.map((row) => row.binding);
    expect(bindings).toContainEqual({ kind: "existing", contributorHandle: "octavia-butler" });
  });

  it("resets creditedName to the new canonical display when Changing a row's binding", async () => {
    installFetch({ searchItems: [searchItem("octavia-butler", "Octavia E. Butler")] });
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Change author for Ursula K. Le Guin" }));
    fireEvent.click(await screen.findByRole("option", { name: /Octavia E\. Butler/ }));
    await waitFor(() =>
      expect(screen.getAllByLabelText("Credited as")[0]!).toHaveValue("Octavia E. Butler"),
    );
  });

  it("gives the open combobox sole Escape ownership: first Escape closes only the listbox", async () => {
    installFetch({ searchItems: [searchItem("octavia-butler", "Octavia E. Butler")] });
    const { props } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Add author" }));
    const combobox = screen.getByRole("combobox");
    fireEvent.change(combobox, { target: { value: "oct" } });
    await screen.findByRole("option", { name: /Octavia/ });

    // First Escape: the listbox closes, but the dialog neither dismisses nor
    // shows the discard confirmation, and the searching row remains.
    fireEvent.keyDown(combobox, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();

    // Second Escape (listbox already closed): abandons the searching row.
    fireEvent.keyDown(combobox, { key: "Escape" });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("removes an abandoned searching row and never persists it", async () => {
    const { puts } = installFetch({ searchItems: [] });
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Add author" }));
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove new author row" }));
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    // The two original rows are unchanged → Save stays disabled, no PUT.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(puts()).toHaveLength(0);
  });

  it("does not enable Save from a pristine Change and never drops the changed row (F1)", async () => {
    const { puts } = installFetch({ searchItems: [searchItem("octavia-butler", "Octavia E. Butler")] });
    renderEditor();
    // Changing a row (no replacement chosen yet) leaves the list value-equal —
    // Save must stay disabled (the row is still visibly present).
    fireEvent.click(screen.getByRole("button", { name: "Change author for Brian Attebery" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    // Choosing a replacement re-binds the row; Save now PUTs BOTH authors — the
    // row being changed is not silently pruned.
    fireEvent.click(await screen.findByRole("option", { name: /Octavia E\. Butler/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const handles = puts()[0]!.body!.authors!.map((row) =>
      row.binding.kind === "existing" ? row.binding.contributorHandle : "new",
    );
    expect(handles).toEqual(["ursula-le-guin", "octavia-butler"]);
  });

  it("cannot open a second concurrent search row that would breach the 20-author cap (F3)", async () => {
    installFetch({ searchItems: [searchItem("new-one", "New One")] });
    const nineteen: MediaAuthorCredit[] = Array.from({ length: 19 }, (_, i) =>
      author(`author-${i}`, `Author ${i}`),
    );
    renderEditor({ authors: nineteen });
    const add = screen.getByRole("button", { name: /Add author/ });
    expect(add).toBeEnabled();
    // Opening one search row makes 20 total rows — a second one (the old bypass)
    // can no longer be opened.
    fireEvent.click(add);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add author/ })).toBeDisabled();
    // Binding it reaches exactly 20 bound; Add stays disabled and the limit shows.
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "new" } });
    fireEvent.click(await screen.findByRole("option", { name: /New One/ }));
    await waitFor(() => expect(screen.getAllByLabelText("Credited as")).toHaveLength(20));
    expect(screen.getByText("A work can have up to 20 authors.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add author/ })).toBeDisabled();
  });

  it("announces the discard confirmation as an alertdialog (H-1)", () => {
    installFetch();
    renderEditor();
    fireEvent.change(screen.getAllByLabelText("Credited as")[0]!, { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("alertdialog", { name: "Discard changes?" })).toBeInTheDocument();
  });

  it("re-homes focus to the moved row after a reorder to an extremity (M-1)", async () => {
    installFetch();
    renderEditor();
    // Moving the first row down lands it last, disabling its Move-down button; the
    // browser would drop focus to <body> unless we re-home it. `toHaveFocus` on
    // the moved row's input proves focus survived (i.e. did not fall to <body>).
    fireEvent.click(screen.getByRole("button", { name: "Move Ursula K. Le Guin down" }));
    await waitFor(() =>
      expect(screen.getByDisplayValue("Ursula K. Le Guin")).toHaveFocus(),
    );
  });

  it("detects a real change even when a credited name contains the old signature delimiters (F6)", () => {
    installFetch();
    const authors: MediaAuthorCredit[] = [
      author("hone-writer", "Name One", "X"),
      author("htwo-writer", "Name Two", "Y"),
    ];
    renderEditor({ authors });
    // Remove the second row, then set the first row's credited name to a value
    // that — under the old hand-joined "~"/"=" signature — collided with the
    // loaded two-row signature and wrongly disabled Save.
    fireEvent.click(screen.getByRole("button", { name: "Remove Y" }));
    fireEvent.change(screen.getAllByLabelText("Credited as")[0]!, {
      target: { value: "X~existing:htwo-writer=Y" },
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("renders in a MobileSheet and runs the dirty guard on a backdrop tap (M-3)", () => {
    setMobileViewport();
    installFetch();
    const { props } = renderEditor({}, { initialViewport: "mobile" });
    expect(screen.getByRole("dialog", { name: "Edit authors" })).toBeInTheDocument();
    fireEvent.change(screen.getAllByLabelText("Credited as")[0]!, { target: { value: "Edited" } });
    fireEvent.click(screen.getByTestId("edit-authors-backdrop"));
    expect(screen.getByRole("alertdialog", { name: "Discard changes?" })).toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("blocks a dirty history Back on mobile and re-arms so a second Back cannot navigate away (M-3)", () => {
    setMobileViewport();
    installFetch();
    const { props } = renderEditor({}, { initialViewport: "mobile" });
    fireEvent.change(screen.getAllByLabelText("Credited as")[0]!, { target: { value: "Edited" } });
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(screen.getByRole("alertdialog", { name: "Discard changes?" })).toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
    // Second immediate Back: still blocked (marker re-armed), no navigation.
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("blocks dismissal while a save is in flight, then completes (F7)", async () => {
    const bodies: PutBody[] = [];
    let releasePut: (() => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "PUT") {
          const body = JSON.parse(String(init!.body)) as PutBody;
          bodies.push(body);
          return await new Promise<Response>((resolve) => {
            releasePut = () => resolve(jsonResponse(defaultPutResult(body)));
          });
        }
        return jsonResponse({ data: { contributors: [], nextCursor: null } });
      }),
    );
    setMobileViewport();
    const { props } = renderEditor({}, { initialViewport: "mobile" });
    fireEvent.change(screen.getAllByLabelText("Credited as")[0]!, { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    // A backdrop tap mid-flight must neither open the discard confirm nor close.
    fireEvent.click(screen.getByTestId("edit-authors-backdrop"));
    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
    // Releasing the PUT closes the editor normally.
    act(() => releasePut!());
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  });
});
