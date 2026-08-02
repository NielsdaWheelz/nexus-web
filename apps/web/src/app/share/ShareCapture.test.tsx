import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Component, type ReactNode } from "react";
import { page } from "vitest/browser";
import ShareCapture from "./ShareCapture";

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
    return this.state.error ? (
      <p>Share defect boundary</p>
    ) : (
      this.props.children
    );
  }
}

function renderShareCapture(text: string, isShell = false) {
  return render(<ShareCapture text={text} isShell={isShell} />);
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

function resourceItem(ref: string, scheme: string, id: string) {
  return {
    ref,
    scheme,
    id,
    label: "",
    summary: "",
    route: null,
    activation: {
      resourceRef: ref,
      kind: "none",
      href: null,
      unresolvedReason: null,
    },
    missing: false,
    capabilities: {
      userRelation: {
        userLinkSource: false,
        userLinkTarget: "none",
        noteReferenceTarget: false,
      },
      sharing: "None",
      libraryPlacement: "None",
      attachable: false,
      chatSubject: "none",
      readable: "none",
      inspectable: "none",
      citableResultType: null,
      citationOutputSource: false,
      appSearchScope: false,
      conversationSearchScope: false,
      promptRender: "none",
      expansionPolicy: "none",
      expandable: false,
      adjacencySource: true,
      adjacencyTarget: true,
    },
    versionByLane: { title: 1, body: 1, outgoing_edges: 1 },
  };
}

function dailyCaptureResponse(
  localDate: string,
  body: Record<string, unknown>,
): Response {
  const pageId = "11111111-1111-4111-8111-111111111111";
  const noteId = String(body.noteId);
  const pageRef = `page:${pageId}`;
  const noteRef = `note_block:${noteId}`;
  return jsonResponse(
    {
      data: {
        clientMutationId: body.clientMutationId,
        localDate,
        pageId,
        surface: {
          source: {
            item: resourceItem(pageRef, "page", pageId),
            content: { kind: "page_title", title: "Today" },
          },
          ordered_items: [
            {
              occurrence_id: "edge-1",
              target: {
                item: resourceItem(noteRef, "note_block", noteId),
                content: {
                  kind: "note_body",
                  body_pm_json: body.bodyPmJson,
                  body_text: "plain note",
                },
              },
            },
          ],
        },
      },
    },
    201,
  );
}

function accountResponse(calendarTimeZone = "UTC"): Response {
  return jsonResponse({
    data: {
      user_id: "account-1",
      default_library_id: "library-1",
      email: "ada@example.com",
      display_name: "Ada",
      calendar_time_zone: calendarTimeZone,
      email_ingest_address: null,
    },
  });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER_USER_HANDLE =
  "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";

function createdLibraryResponse(body: Record<string, unknown>): Response {
  return jsonResponse(
    {
      data: {
        id: body.library_id,
        name: String(body.name),
        color: null,
        ownerUserHandle: OWNER_USER_HANDLE,
        isDefault: false,
        role: "admin",
        systemKey: null,
        canRename: true,
        canDelete: true,
        canEditEntries: true,
        canManageMembers: true,
        canTransferOwnership: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    },
    201,
  );
}

function installShareFetch({
  fromUrl,
  createLibrary,
  profile,
  dailyCapture,
}: {
  fromUrl?: (body: Record<string, unknown>) => Response | Promise<Response>;
  createLibrary?: (
    body: Record<string, unknown>,
  ) => Response | Promise<Response>;
  profile?: () => Response | Promise<Response>;
  dailyCapture?: (
    localDate: string,
    body: Record<string, unknown>,
  ) => Response | Promise<Response>;
} = {}) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = pathFor(input);
      const url = new URL(path, "http://localhost");
      const method = init?.method ?? "GET";

      if (url.pathname === "/api/me" && method === "GET") {
        return profile ? profile() : accountResponse();
      }

      if (url.pathname === "/api/libraries/writable-destinations") {
        const query = (url.searchParams.get("q") ?? "").trim();
        return jsonResponse({
          data: query
            ? []
            : [
                {
                  id: "lib-research",
                  name: "Research",
                  color: "#0ea5e9",
                  created_at: "2026-01-01T00:00:00Z",
                  updated_at: "2026-01-01T00:00:00Z",
                },
              ],
          page: { has_more: false, next_cursor: null },
        });
      }

      if (url.pathname === "/api/libraries" && method === "POST") {
        const body = parseJsonBody(init);
        if (createLibrary) return createLibrary(body);
        return createdLibraryResponse(body);
      }

      if (url.pathname === "/api/media/from-url" && method === "POST") {
        const body = parseJsonBody(init);
        if (fromUrl) return fromUrl(body);
        return jsonResponse({
          data: {
            media_id: "media-1",
            source_attempt_id: "attempt-1",
            source_type: "generic_web_url",
            source_attempt_status: "queued",
            idempotency_outcome: "created",
            processing_status: "pending",
            ingest_enqueued: true,
          },
        });
      }

      const dailyCaptureMatch =
        /^\/api\/notes\/daily\/(\d{4}-\d{2}-\d{2})\/captures$/.exec(
          url.pathname,
        );
      if (dailyCaptureMatch && method === "POST") {
        const body = parseJsonBody(init);
        const localDate = dailyCaptureMatch[1]!;
        return dailyCapture
          ? dailyCapture(localDate, body)
          : dailyCaptureResponse(localDate, body);
      }

      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function fromUrlBodies(fetchMock: ReturnType<typeof installShareFetch>) {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        new URL(pathFor(input), "http://localhost").pathname ===
          "/api/media/from-url" && init?.method === "POST",
    )
    .map(([, init]) => parseJsonBody(init));
}

function dailyCaptureCalls(fetchMock: ReturnType<typeof installShareFetch>) {
  return fetchMock.mock.calls
    .flatMap(([input, init]) => {
      const pathname = new URL(pathFor(input), "http://localhost").pathname;
      const match =
        /^\/api\/notes\/daily\/(\d{4}-\d{2}-\d{2})\/captures$/.exec(
          pathname,
        );
      return match && init?.method === "POST"
        ? [{ localDate: match[1]!, body: parseJsonBody(init) }]
        : [];
    });
}

function profileCalls(fetchMock: ReturnType<typeof installShareFetch>) {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      new URL(pathFor(input), "http://localhost").pathname === "/api/me" &&
      (init?.method ?? "GET") === "GET",
  );
}

function libraryCreateBodies(
  fetchMock: ReturnType<typeof installShareFetch>,
) {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        new URL(pathFor(input), "http://localhost").pathname ===
          "/api/libraries" && init?.method === "POST",
    )
    .map(([, init]) => parseJsonBody(init));
}

describe("ShareCapture", () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await page.viewport(1024, 768);
  });

  it("does not ingest URL shares on mount", async () => {
    const fetchMock = installShareFetch();

    renderShareCapture("https://example.com/article");

    expect(
      screen.getByRole("heading", { name: "Save to Nexus" }),
    ).toBeInTheDocument();
    expect(fromUrlBodies(fetchMock)).toEqual([]);
  });

  it("cancels before Save without ingesting", async () => {
    const fetchMock = installShareFetch();

    renderShareCapture("https://example.com/article");

    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute(
      "href",
      "/lectern",
    );
    expect(fromUrlBodies(fetchMock)).toEqual([]);
  });

  it("labels the empty destination selection with no default library copy", async () => {
    installShareFetch();

    renderShareCapture("https://example.com/article");

    expect(
      await screen.findByText("No additional libraries"),
    ).toBeInTheDocument();
    expect(screen.queryByText("My Library only")).not.toBeInTheDocument();
  });

  it("saves selected library ids in the initial from-url call", async () => {
    const fetchMock = installShareFetch();

    renderShareCapture("https://example.com/article");

    fireEvent.click(
      screen.getByRole("button", { name: /^Library destinations:/ }),
    );
    const option = await screen.findByRole("option", { name: "Research" });
    fireEvent.click(option);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Saved to Nexus");
    expect(fromUrlBodies(fetchMock)).toContainEqual({
      url: "https://example.com/article",
      library_ids: ["lib-research"],
    });
  });

  it("creates a destination and saves with the created id", async () => {
    const fetchMock = installShareFetch();

    renderShareCapture("https://example.com/article");

    fireEvent.click(
      screen.getByRole("button", { name: /^Library destinations:/ }),
    );
    const input = await screen.findByRole("combobox", {
      name: "Search or create a library",
    });
    fireEvent.change(input, { target: { value: "Created" } });
    fireEvent.click(await screen.findByText("Create “Created”"));
    await screen.findByRole("option", { name: "Created" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const createdId = libraryCreateBodies(fetchMock)[0]?.library_id;
      expect(createdId).toMatch(UUID_RE);
      expect(fromUrlBodies(fetchMock)).toContainEqual({
        url: "https://example.com/article",
        library_ids: [createdId],
      });
    });
  });

  it("does not save while destination creation is pending", async () => {
    const fetchMock = installShareFetch({
      createLibrary: () => new Promise<Response>(() => {}),
    });

    renderShareCapture("https://example.com/article");

    fireEvent.click(
      screen.getByRole("button", { name: /^Library destinations:/ }),
    );
    const input = await screen.findByRole("combobox", {
      name: "Search or create a library",
    });
    fireEvent.change(input, { target: { value: "Created" } });
    fireEvent.click(await screen.findByText("Create “Created”"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fromUrlBodies(fetchMock)).toEqual([]);
  });

  it("uses the same selected ids for every URL", async () => {
    const fetchMock = installShareFetch({
      fromUrl: (body) =>
        jsonResponse({
          data: {
            media_id: String(body.url).includes("one")
              ? "media-one"
              : "media-two",
            source_attempt_id: String(body.url).includes("one")
              ? "attempt-one"
              : "attempt-two",
            source_type: "generic_web_url",
            source_attempt_status: "queued",
            idempotency_outcome: "created",
            processing_status: "pending",
            ingest_enqueued: true,
          },
        }),
    });

    renderShareCapture("https://example.com/one https://example.com/two");

    fireEvent.click(
      screen.getByRole("button", { name: /^Library destinations:/ }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Research" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Saved to Nexus");
    expect(fromUrlBodies(fetchMock)).toContainEqual({
      url: "https://example.com/one",
      library_ids: ["lib-research"],
    });
    expect(fromUrlBodies(fetchMock)).toContainEqual({
      url: "https://example.com/two",
      library_ids: ["lib-research"],
    });
  });

  it("retries failed URLs with the same selected ids", async () => {
    let attempt = 0;
    const fetchMock = installShareFetch({
      fromUrl: () => {
        attempt += 1;
        if (attempt === 1) {
          return jsonResponse(
            { error: { code: "E_BAD_REQUEST", message: "failed" } },
            400,
          );
        }
        return jsonResponse({
          data: {
            media_id: "media-1",
            source_attempt_id: "attempt-1",
            source_type: "generic_web_url",
            source_attempt_status: "queued",
            idempotency_outcome: "created",
            processing_status: "pending",
            ingest_enqueued: true,
          },
        });
      },
    });

    renderShareCapture("https://example.com/article");

    fireEvent.click(
      screen.getByRole("button", { name: /^Library destinations:/ }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Research" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("heading", { name: "Couldn’t save" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(fromUrlBodies(fetchMock)).toHaveLength(2);
    });
    expect(fromUrlBodies(fetchMock).at(-1)).toEqual({
      url: "https://example.com/article",
      library_ids: ["lib-research"],
    });
  });

  it("shows X provider failures with the backend request id", async () => {
    installShareFetch({
      fromUrl: () =>
        jsonResponse(
          {
            error: {
              code: "E_X_PROVIDER_CREDITS_DEPLETED",
              message: "X imports are temporarily unavailable.",
              request_id: "req-x-1",
            },
          },
          503,
        ),
    });

    renderShareCapture("https://x.com/ada/status/1234567890");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("heading", { name: "Couldn’t save" });
    expect(
      screen.getByText("X imports are temporarily unavailable."),
    ).toBeInTheDocument();
    expect(screen.getByText("Nexus request ID: req-x-1")).toBeInTheDocument();
  });

  it("renders expired-session capture as the share-owned sign-in outcome", async () => {
    installShareFetch({
      fromUrl: () =>
        jsonResponse(
          {
            error: {
              code: "E_UNAUTHENTICATED",
              message: "Session expired",
            },
          },
          401,
        ),
    });

    renderShareCapture("https://example.com/expired");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("heading", { name: "Sign in to save this" });
    expect(
      screen.getByText("Open Nexus, sign in, then share again."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("link", { name: "Done" })).toHaveAttribute(
      "href",
      "/lectern",
    );
  });

  it("retains fulfilled peers when another URL finds an expired session", async () => {
    const fetchMock = installShareFetch({
      fromUrl: (body) =>
        String(body.url).endsWith("/one")
          ? jsonResponse({
              data: {
                media_id: "media-one",
                source_attempt_id: "attempt-one",
                source_type: "generic_web_url",
                source_attempt_status: "queued",
                idempotency_outcome: "created",
                processing_status: "pending",
                ingest_enqueued: true,
              },
            })
          : jsonResponse(
              {
                error: {
                  code: "E_UNAUTHENTICATED",
                  message: "Session expired",
                },
              },
              401,
            ),
    });

    renderShareCapture("https://example.com/one https://example.com/two");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("heading", { name: "Saved to Nexus" });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByText("Sign in to save this")).toBeInTheDocument();
    expect(fromUrlBodies(fetchMock)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("propagates same-system URL capture defects to the owner boundary", async () => {
    const onDefect = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    installShareFetch({
      fromUrl: () =>
        jsonResponse(
          {
            error: {
              code: "E_INTERNAL",
              message: "Malformed source state",
              request_id: "req-share-defect",
            },
          },
          500,
        ),
    });

    try {
      render(
        <DefectBoundary onDefect={onDefect}>
          <ShareCapture text="https://example.com/defect" isShell={false} />
        </DefectBoundary>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(
        await screen.findByText("Share defect boundary"),
      ).toBeInTheDocument();
      expect(onDefect).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E_INTERNAL" }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("treats accepted failed source ingestion as a saved item", async () => {
    installShareFetch({
      fromUrl: () =>
        jsonResponse({
          data: {
            media_id: "media-failed",
            source_attempt_id: "attempt-failed",
            source_type: "x_author_thread",
            source_attempt_status: "failed",
            idempotency_outcome: "created",
            processing_status: "failed",
            ingest_enqueued: false,
          },
        }),
    });

    renderShareCapture("https://x.com/ada/status/1234567890");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("heading", { name: "Saved to Nexus" });
    expect(screen.getByText("Saved, but ingestion failed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open in Nexus" })).toHaveAttribute(
      "href",
      "/media/media-failed",
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("bounds URL save concurrency", async () => {
    const releases: Array<() => void> = [];
    const fetchMock = installShareFetch({
      fromUrl: () =>
        new Promise<Response>((resolve) => {
          releases.push(() =>
            resolve(
              jsonResponse({
                data: {
                  media_id: `media-${releases.length}`,
                  source_attempt_id: `attempt-${releases.length}`,
                  source_type: "generic_web_url",
                  source_attempt_status: "queued",
                  idempotency_outcome: "created",
                  processing_status: "pending",
                  ingest_enqueued: true,
                },
              }),
            ),
          );
        }),
    });

    renderShareCapture(
      "https://example.com/one https://example.com/two https://example.com/three",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fromUrlBodies(fetchMock)).toHaveLength(2));
    releases.shift()?.();
    await waitFor(() => expect(fromUrlBodies(fetchMock)).toHaveLength(3));
    releases.shift()?.();
    releases.shift()?.();
  });

  it("reads the account profile before dated plain-text capture", async () => {
    const fetchMock = installShareFetch();

    renderShareCapture("plain note");

    await screen.findByText("Added to today");
    const [capture] = dailyCaptureCalls(fetchMock);
    expect(capture).toEqual({
      localDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      body: {
        noteId: expect.stringMatching(UUID_RE),
        clientMutationId: expect.stringMatching(/^share-note-mutation-/),
        bodyPmJson: {
          type: "paragraph",
          content: [{ type: "text", text: "plain note" }],
        },
      },
    });
    const requestedPaths = fetchMock.mock.calls.map(([input]) => pathFor(input));
    expect(requestedPaths.indexOf("/api/me")).toBeLessThan(
      requestedPaths.findIndex((path) => path.endsWith("/captures")),
    );
    expect(
      screen.queryByRole("button", { name: /^Library destinations:/ }),
    ).toBeNull();
  });

  it("sends no capture after a profile-read failure and retries the profile", async () => {
    let profileAttempt = 0;
    const fetchMock = installShareFetch({
      profile: () => {
        profileAttempt += 1;
        return profileAttempt <= 3
          ? jsonResponse(
              { error: { code: "E_NETWORK", message: "profile failed" } },
              503,
            )
          : accountResponse("UTC");
      },
    });

    renderShareCapture("plain note");

    await screen.findByRole("heading", { name: "Couldn’t save" });
    expect(dailyCaptureCalls(fetchMock)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await screen.findByText("Added to today");
    expect(profileCalls(fetchMock)).toHaveLength(4);
    expect(dailyCaptureCalls(fetchMock)).toHaveLength(1);
  });

  it("propagates an account profile contract defect without sending a capture", async () => {
    const onDefect = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const fetchMock = installShareFetch({
      profile: () =>
        jsonResponse({
          data: {
            user_id: "account-1",
            default_library_id: "library-1",
            email: "ada@example.com",
            display_name: "Ada",
            calendarTimeZone: "UTC",
            email_ingest_address: null,
          },
        }),
    });

    try {
      render(
        <DefectBoundary onDefect={onDefect}>
          <ShareCapture text="plain note" isShell={false} />
        </DefectBoundary>,
      );

      expect(
        await screen.findByText("Share defect boundary"),
      ).toBeInTheDocument();
      expect(onDefect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "AuthenticatedAccountContractDefect",
        }),
      );
      expect(dailyCaptureCalls(fetchMock)).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("freezes the date and identities when capture retries across midnight", async () => {
    const formatToParts = vi
      .fn()
      .mockReturnValueOnce([
        { type: "month", value: "07" },
        { type: "literal", value: "/" },
        { type: "day", value: "30" },
        { type: "literal", value: "/" },
        { type: "year", value: "2026" },
      ])
      .mockReturnValueOnce([
        { type: "month", value: "07" },
        { type: "literal", value: "/" },
        { type: "day", value: "31" },
        { type: "literal", value: "/" },
        { type: "year", value: "2026" },
    ]);
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      function MockDateTimeFormat() {
        return { formatToParts } as unknown as Intl.DateTimeFormat;
      } as typeof Intl.DateTimeFormat,
    );
    let captureAttempt = 0;
    const fetchMock = installShareFetch({
      dailyCapture: (localDate, body) => {
        captureAttempt += 1;
        return captureAttempt === 1
          ? jsonResponse(
              { error: { code: "E_NETWORK", message: "capture failed" } },
              503,
            )
          : dailyCaptureResponse(localDate, body);
      },
    });

    renderShareCapture("plain note");

    await screen.findByRole("heading", { name: "Couldn’t save" });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Added to today");

    const captures = dailyCaptureCalls(fetchMock);
    expect(captures).toHaveLength(2);
    expect(captures[0]).toEqual(captures[1]);
    expect(captures[0]?.localDate).toBe("2026-07-30");
    expect(profileCalls(fetchMock)).toHaveLength(1);
    expect(formatToParts).toHaveBeenCalledTimes(1);
  });

  it("does not render the old post-save add-libraries modal", async () => {
    installShareFetch();

    renderShareCapture("https://example.com/article");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Saved to Nexus");
    expect(
      screen.queryByRole("dialog", { name: "Add to libraries?" }),
    ).toBeNull();
  });

  it("uses Android shell callbacks for open and completion links", async () => {
    installShareFetch();

    renderShareCapture("https://example.com/article", true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Saved to Nexus");
    expect(screen.getByRole("link", { name: "Open in Nexus" })).toHaveAttribute(
      "href",
      "nexus-share://open?path=%2Fmedia%2Fmedia-1",
    );
    expect(screen.getByRole("link", { name: "Done" })).toHaveAttribute(
      "href",
      "nexus-share://done",
    );
  });
});
