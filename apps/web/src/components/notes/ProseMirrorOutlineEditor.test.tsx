import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { Component, type ReactNode } from "react";
import { outlineSchema } from "@/lib/notes/prosemirror/schema";
import type { HydratedObjectRef } from "@/lib/objectRefs";
import ProseMirrorOutlineEditor from "./ProseMirrorOutlineEditor";

class DefectBoundary extends Component<
  { children: ReactNode; onDefect: (error: unknown) => void },
  { error: unknown | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    this.props.onDefect(error);
  }

  render() {
    return this.state.error ? (
      <p>Attachment defect boundary</p>
    ) : (
      this.props.children
    );
  }
}

describe("ProseMirrorOutlineEditor object refs", () => {
  it("uploads dropped files and inserts media embeds", async () => {
    const mediaId = "99999999-9999-4999-8999-999999999999";
    const onDocChange = vi.fn();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/media/upload/init")) {
          return jsonResponse({
            data: {
              media_id: mediaId,
              source_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              source_type: "upload",
              source_attempt_status: "accepted",
              idempotency_outcome: "created",
              processing_status: "pending",
              ingest_enqueued: false,
              upload_url: "https://uploads.example/paper.pdf",
              expires_at: "2026-01-01T00:00:00Z",
            },
          });
        }
        if (
          url === "https://uploads.example/paper.pdf" &&
          init?.method === "PUT"
        ) {
          return new Response(null, { status: 200 });
        }
        if (url.endsWith(`/api/media/${mediaId}/ingest`)) {
          return jsonResponse({
            data: {
              media_id: mediaId,
              source_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              source_type: "upload",
              source_attempt_status: "queued",
              idempotency_outcome: "created",
              duplicate: false,
              processing_status: "pending",
              ingest_enqueued: true,
            },
          });
        }
        return jsonResponse({ data: {} }, { status: 404 });
      });

    try {
      render(
        <ProseMirrorOutlineEditor
          resourceKey="test:file-drop"
          initialDoc={emptyDoc()}
          createBlockId={() => "attachment-block"}
          onDocChange={onDocChange}
        />,
      );

      const editor = screen.getByRole("textbox", { name: "Notes outline" });
      dropFile(
        editor,
        new File(["%PDF-1.7"], "paper.pdf", { type: "application/pdf" }),
      );

      await screen.findByRole("link", { name: "Open paper.pdf" });
      await waitFor(() => {
        expect(lastDocJson(onDocChange)).toMatchObject({
          content: [
            {},
            {
              attrs: { id: "attachment-block" },
              content: [
                {
                  type: "object_embed",
                  attrs: {
                    objectType: "media",
                    objectId: mediaId,
                    label: "paper.pdf",
                    relationType: "embeds",
                  },
                },
              ],
            },
          ],
        });
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("locks and preserves the single-block insertion target through a deferred upload", async () => {
    const mediaId = "98989898-9898-4898-8989-989898989898";
    const onDocChange = vi.fn();
    let resolveInit!: (response: Response) => void;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/media/upload/init")) {
          return new Promise<Response>((resolve) => {
            resolveInit = resolve;
          });
        }
        if (url === "https://uploads.example/stable.pdf") {
          return new Response(null, { status: 200 });
        }
        if (url.endsWith(`/api/media/${mediaId}/ingest`)) {
          return jsonResponse({
            data: {
              media_id: mediaId,
              source_attempt_id: "abababab-abab-4bab-8bab-abababababab",
              source_type: "upload",
              source_attempt_status: "queued",
              idempotency_outcome: "created",
              duplicate: false,
              processing_status: "pending",
              ingest_enqueued: true,
            },
          });
        }
        throw new Error(`Unexpected fetch: ${url} ${init?.method}`);
      });

    try {
      render(
        <ProseMirrorOutlineEditor
          resourceKey="test:stable-single-block-upload"
          initialDoc={emptyDoc()}
          createBlockId={() => "unused-for-single-block"}
          singleBlock
          onDocChange={onDocChange}
        />,
      );
      const editor = screen.getByRole("textbox", { name: "Notes outline" });
      dropFile(
        editor,
        new File(["%PDF-1.7"], "stable.pdf", { type: "application/pdf" }),
      );
      await waitFor(() =>
        expect(editor).toHaveAttribute("contenteditable", "false"),
      );
      await userEvent.click(editor);
      await userEvent.keyboard("must not replace the reserved target");
      expect(editor).not.toHaveTextContent("must not replace");

      resolveInit(
        jsonResponse({
          data: {
            media_id: mediaId,
            source_attempt_id: "abababab-abab-4bab-8bab-abababababab",
            source_type: "upload",
            source_attempt_status: "accepted",
            idempotency_outcome: "created",
            processing_status: "pending",
            ingest_enqueued: false,
            upload_url: "https://uploads.example/stable.pdf",
            expires_at: "2026-01-01T00:00:00Z",
          },
        }),
      );

      await screen.findByRole("link", { name: "Open stable.pdf" });
      await waitFor(() =>
        expect(editor).toHaveAttribute("contenteditable", "true"),
      );
      const json = JSON.stringify(lastDocJson(onDocChange));
      expect(json.match(new RegExp(mediaId, "g"))).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("persists accepted identity once before propagating a post-init defect", async () => {
    const mediaId = "97979797-9797-4797-8979-979797979797";
    const onDocChange = vi.fn();
    const onDefect = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let initCalls = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/api/media/upload/init")) {
          initCalls += 1;
          return jsonResponse({
            data: {
              media_id: mediaId,
              source_attempt_id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
              source_type: "upload",
              source_attempt_status: "accepted",
              idempotency_outcome: "created",
              processing_status: "pending",
              ingest_enqueued: false,
              upload_url: "https://uploads.example/defect-after-init.pdf",
              expires_at: "2026-01-01T00:00:00Z",
            },
          });
        }
        if (url === "https://uploads.example/defect-after-init.pdf") {
          return new Response(null, { status: 200 });
        }
        if (url.endsWith(`/api/media/${mediaId}/ingest`)) {
          return jsonResponse(
            {
              error: {
                code: "E_INTERNAL",
                message: "Malformed confirmation",
              },
            },
            { status: 500 },
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

    try {
      render(
        <DefectBoundary onDefect={onDefect}>
          <ProseMirrorOutlineEditor
            resourceKey="test:post-init-defect"
            initialDoc={emptyDoc()}
            createBlockId={() => "post-init-attachment"}
            onDocChange={onDocChange}
          />
        </DefectBoundary>,
      );
      dropFile(
        screen.getByRole("textbox", { name: "Notes outline" }),
        new File(["%PDF-1.7"], "defect-after-init.pdf", {
          type: "application/pdf",
        }),
      );

      await screen.findByText("Attachment defect boundary");
      expect(onDefect).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E_INTERNAL" }),
      );
      expect(initCalls).toBe(1);
      const json = JSON.stringify(lastDocJson(onDocChange));
      expect(json.match(new RegExp(mediaId, "g"))).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("preserves accepted-but-uncertain upload feedback after attaching the identity", async () => {
    const mediaId = "77777777-7777-4777-8777-777777777777";
    const onFeedback = vi.fn();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/media/upload/init")) {
          return jsonResponse({
            data: {
              media_id: mediaId,
              source_attempt_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              source_type: "upload",
              source_attempt_status: "accepted",
              idempotency_outcome: "created",
              processing_status: "pending",
              ingest_enqueued: false,
              upload_url: "https://uploads.example/uncertain.pdf",
              expires_at: "2026-01-01T00:00:00Z",
            },
          });
        }
        if (
          url === "https://uploads.example/uncertain.pdf" &&
          init?.method === "PUT"
        ) {
          return new Response(null, { status: 200 });
        }
        if (url.endsWith(`/api/media/${mediaId}/ingest`)) {
          return jsonResponse(
            {
              error: {
                code: "E_UPSTREAM_TIMEOUT",
                message: "Confirmation timed out",
                request_id: "req-attachment-confirm",
              },
            },
            { status: 504 },
          );
        }
        return jsonResponse({ data: {} }, { status: 404 });
      });

    try {
      render(
        <ProseMirrorOutlineEditor
          resourceKey="test:uncertain-file-drop"
          initialDoc={emptyDoc()}
          createBlockId={() => "uncertain-attachment-block"}
          onFeedback={onFeedback}
        />,
      );

      dropFile(
        screen.getByRole("textbox", { name: "Notes outline" }),
        new File(["%PDF-1.7"], "uncertain.pdf", { type: "application/pdf" }),
      );

      await screen.findByRole("link", { name: "Open uncertain.pdf" });
      await waitFor(() => {
        expect(onFeedback).toHaveBeenCalledWith({
          severity: "warning",
          title: "Backend service timed out",
          requestId: "req-attachment-confirm",
        });
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("reports processing failure as a warning after attaching the accepted identity", async () => {
    const mediaId = "66666666-6666-4666-8666-666666666666";
    const onFeedback = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: {
          media_id: mediaId,
          source_attempt_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          source_type: "upload",
          source_attempt_status: "failed",
          idempotency_outcome: "reused",
          processing_status: "failed",
          ingest_enqueued: false,
          upload_url: null,
          expires_at: null,
        },
      }),
    );

    try {
      render(
        <ProseMirrorOutlineEditor
          resourceKey="test:failed-processing-file-drop"
          initialDoc={emptyDoc()}
          createBlockId={() => "failed-processing-attachment-block"}
          onFeedback={onFeedback}
        />,
      );

      dropFile(
        screen.getByRole("textbox", { name: "Notes outline" }),
        new File(["%PDF-1.7"], "processing-failed.pdf", {
          type: "application/pdf",
        }),
      );

      await screen.findByRole("link", { name: "Open processing-failed.pdf" });
      await waitFor(() => {
        expect(onFeedback).toHaveBeenCalledWith({
          severity: "warning",
          title: "File was attached, but source processing failed.",
        });
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("reports unsupported dropped files", async () => {
    const onError = vi.fn();

    render(
      <ProseMirrorOutlineEditor
        resourceKey="test:unsupported-file-drop"
        initialDoc={emptyDoc()}
        createBlockId={() => "attachment-block"}
        onError={onError}
      />,
    );

    dropFile(
      screen.getByRole("textbox", { name: "Notes outline" }),
      new File(["notes"], "notes.txt", { type: "text/plain" }),
    );

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(String(onError.mock.calls[0]?.[0])).toContain("Only PDF and EPUB");
    });
  });

  it("propagates same-system upload defects to the owner boundary", async () => {
    const onError = vi.fn();
    const onDefect = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "E_INTERNAL",
            message: "Malformed upload state",
            request_id: "req-note-defect",
          },
        },
        { status: 500 },
      ),
    );

    try {
      render(
        <DefectBoundary onDefect={onDefect}>
          <ProseMirrorOutlineEditor
            resourceKey="test:file-defect"
            initialDoc={emptyDoc()}
            createBlockId={() => "attachment-block"}
            onError={onError}
          />
        </DefectBoundary>,
      );

      dropFile(
        screen.getByRole("textbox", { name: "Notes outline" }),
        new File(["%PDF-1.7"], "defect.pdf", { type: "application/pdf" }),
      );

      expect(
        await screen.findByText("Attachment defect boundary"),
      ).toBeInTheDocument();
      expect(onDefect).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E_INTERNAL" }),
      );
      expect(onError).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("propagates same-system pasted-URL defects to the owner boundary", async () => {
    const onError = vi.fn();
    const onDefect = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "E_INTERNAL",
            message: "Malformed source state",
            request_id: "req-note-url-defect",
          },
        },
        { status: 500 },
      ),
    );

    try {
      render(
        <DefectBoundary onDefect={onDefect}>
          <ProseMirrorOutlineEditor
            resourceKey="test:url-defect"
            initialDoc={emptyDoc()}
            createBlockId={() => "attachment-block"}
            onError={onError}
          />
        </DefectBoundary>,
      );

      pasteText(
        screen.getByRole("textbox", { name: "Notes outline" }),
        "https://example.com/defect",
      );

      expect(
        await screen.findByText("Attachment defect boundary"),
      ).toBeInTheDocument();
      expect(onDefect).toHaveBeenCalledWith(
        expect.objectContaining({ code: "E_INTERNAL" }),
      );
      expect(onError).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("uploads pasted URLs and inserts media embeds", async () => {
    const mediaId = "88888888-8888-4888-8888-888888888888";
    const onDocChange = vi.fn();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/media/from-url" && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          expect(body).toMatchObject({
            url: "https://example.com/research",
            library_ids: [],
          });
          return jsonResponse({
            data: {
              media_id: mediaId,
              source_attempt_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              source_type: "generic_web_url",
              source_attempt_status: "queued",
              idempotency_outcome: "created",
              processing_status: "pending",
              ingest_enqueued: true,
            },
          });
        }
        return jsonResponse({ data: {} }, { status: 404 });
      });

    try {
      render(
        <ProseMirrorOutlineEditor
          resourceKey="test:url-paste"
          initialDoc={emptyDoc()}
          createBlockId={() => "url-attachment-block"}
          onDocChange={onDocChange}
        />,
      );

      const editor = screen.getByRole("textbox", { name: "Notes outline" });
      pasteText(editor, "https://example.com/research");

      await screen.findByRole("link", {
        name: "Open https://example.com/research",
      });
      await waitFor(() => {
        expect(lastDocJson(onDocChange)).toMatchObject({
          content: [
            {},
            {
              attrs: { id: "url-attachment-block" },
              content: [
                {
                  type: "object_embed",
                  attrs: {
                    objectType: "media",
                    objectId: mediaId,
                    label: "https://example.com/research",
                    relationType: "embeds",
                  },
                },
              ],
            },
          ],
        });
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not replace existing single-block text on URL-only paste", async () => {
    const onDocChange = vi.fn();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ data: {} }, { status: 500 }));

    try {
      render(
        <ProseMirrorOutlineEditor
          resourceKey="test:single-block-url-paste"
          initialDoc={textDoc("keep this note")}
          createBlockId={() => "url-attachment-block"}
          singleBlock
          onDocChange={onDocChange}
        />,
      );

      pasteText(
        screen.getByRole("textbox", { name: "Notes outline" }),
        "https://example.com/research",
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(lastDocJson(onDocChange)).toMatchObject({
          content: [
            {
              attrs: { id: "block-1" },
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "https://example.com/researchkeep this note",
                    },
                  ],
                },
              ],
            },
          ],
        });
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("opens focused object refs from the keyboard", async () => {
    const objectId = "11111111-1111-4111-8111-111111111111";
    const onOpenObject = vi.fn();

    render(
      <ProseMirrorOutlineEditor
        resourceKey="test:object-ref"
        initialDoc={noteDoc(objectId)}
        onOpenObject={onOpenObject}
      />,
    );

    const objectRef = await screen.findByRole("link", {
      name: "Open Source media",
    });
    objectRef.focus();
    fireEvent.keyDown(objectRef, { key: "Enter", shiftKey: true });

    expect(onOpenObject).toHaveBeenCalledWith("media", objectId, true);
  });

  it("leaves typed tag resource refs as text", async () => {
    const user = userEvent.setup();
    const tagId = "77777777-7777-4777-8777-777777777777";

    render(
      <ProseMirrorOutlineEditor
        resourceKey="test:tag-object-ref"
        initialDoc={emptyDoc()}
        searchObjects={async () => []}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Notes outline" });
    await user.click(editor);
    await user.keyboard(`[[[[tag:${tagId}|#sota]]`);

    expect(screen.queryByRole("link", { name: "Open #sota" })).toBeNull();
    expect(editor).toHaveTextContent(`[[tag:${tagId}|#sota]]`);
  });

  it("inserts object refs from @ autocomplete", async () => {
    const user = userEvent.setup();
    const objectId = "22222222-2222-4222-8222-222222222222";
    const searchObjects = vi.fn(
      async (): Promise<HydratedObjectRef[]> => [
        {
          objectType: "media",
          objectId,
          label: "Evergreen Source",
          route: `/media/${objectId}`,
        },
      ],
    );

    render(
      <ProseMirrorOutlineEditor
        resourceKey="test:autocomplete"
        initialDoc={emptyDoc()}
        searchObjects={searchObjects}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Notes outline" });
    await user.click(editor);
    await user.keyboard("@Evergreen");
    const option = await screen.findByRole("option", {
      name: /Evergreen Source/,
    });
    expect(editor).toHaveAttribute("aria-expanded", "true");
    expect(editor).toHaveAttribute("aria-controls");
    expect(editor).toHaveAttribute("aria-activedescendant", option.id);
    await user.click(option);

    await screen.findByRole("link", { name: "Open Evergreen Source" });
    await waitFor(() => {
      expect(searchObjects).toHaveBeenLastCalledWith("Evergreen", {});
    });
  });

  it("inserts page and note refs from [[ autocomplete", async () => {
    const user = userEvent.setup();
    const pageId = "44444444-4444-4444-8444-444444444444";
    const noteBlockId = "55555555-5555-4555-8555-555555555555";
    const mediaId = "66666666-6666-4666-8666-666666666666";
    const searchObjects = vi.fn(
      async (): Promise<HydratedObjectRef[]> => [
        {
          objectType: "media",
          objectId: mediaId,
          label: "Evergreen Media",
          route: `/media/${mediaId}`,
        },
        {
          objectType: "page",
          objectId: pageId,
          label: "Evergreen Page",
          route: `/pages/${pageId}`,
        },
        {
          objectType: "note_block",
          objectId: noteBlockId,
          label: "Evergreen Note",
          route: `/notes/${noteBlockId}`,
        },
      ],
    );

    render(
      <ProseMirrorOutlineEditor
        resourceKey="test:page-autocomplete"
        initialDoc={emptyDoc()}
        searchObjects={searchObjects}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Notes outline" });
    await user.click(editor);
    await user.keyboard("[[[[Evergreen");
    const option = await screen.findByRole("option", {
      name: /Evergreen Page/,
    });

    expect(
      screen.queryByRole("option", { name: /Evergreen Media/ }),
    ).toBeNull();

    await user.click(option);

    await screen.findByRole("link", { name: "Open Evergreen Page" });
    await waitFor(() => {
      expect(searchObjects).toHaveBeenLastCalledWith("Evergreen", {
        objectTypes: ["page", "note_block"],
      });
    });
  });

  it("keeps hashtags as text without opening autocomplete", async () => {
    const user = userEvent.setup();
    const searchObjects = vi.fn(async (): Promise<HydratedObjectRef[]> => []);

    render(
      <ProseMirrorOutlineEditor
        resourceKey="test:tag-autocomplete"
        initialDoc={emptyDoc()}
        searchObjects={searchObjects}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Notes outline" });
    await user.click(editor);
    await user.keyboard("#sot");

    expect(searchObjects).not.toHaveBeenCalled();
    expect(screen.queryByRole("option")).toBeNull();
    expect(editor).toHaveTextContent("#sot");
  });

  it("opens object ref autocomplete for selected text with Mod+K", async () => {
    const user = userEvent.setup();
    const objectId = "33333333-3333-4333-8333-333333333333";
    const searchObjects = vi.fn(
      async (): Promise<HydratedObjectRef[]> => [
        {
          objectType: "page",
          objectId,
          label: "Evergreen Page",
          route: `/pages/${objectId}`,
        },
      ],
    );

    render(
      <ProseMirrorOutlineEditor
        resourceKey="test:selection-autocomplete"
        initialDoc={emptyDoc()}
        searchObjects={searchObjects}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Notes outline" });
    await user.click(editor);
    await user.keyboard("Evergreen");
    await user.keyboard("{Shift>}");
    for (let index = 0; index < "Evergreen".length; index += 1) {
      await user.keyboard("{ArrowLeft}");
    }
    await user.keyboard("{/Shift}");

    fireEvent.keyDown(editor, { key: "k", metaKey: true });
    const option = await screen.findByRole("option", {
      name: /Evergreen Page/,
    });
    await user.click(option);

    await screen.findByRole("link", { name: "Open Evergreen Page" });
    await waitFor(() => {
      expect(searchObjects).toHaveBeenLastCalledWith("Evergreen", {});
    });
  });

  it("keeps focus in the editor and inserts the active autocomplete option from the keyboard", async () => {
    const user = userEvent.setup();
    const firstId = "88888888-8888-4888-8888-888888888888";
    const secondId = "99999999-9999-4999-8999-999999999999";
    const searchObjects = vi.fn(
      async (): Promise<HydratedObjectRef[]> => [
        {
          objectType: "page",
          objectId: firstId,
          label: "Evergreen First",
          route: `/pages/${firstId}`,
        },
        {
          objectType: "page",
          objectId: secondId,
          label: "Evergreen Second",
          route: `/pages/${secondId}`,
        },
      ],
    );

    render(
      <ProseMirrorOutlineEditor
        resourceKey="test:keyboard-autocomplete"
        initialDoc={emptyDoc()}
        searchObjects={searchObjects}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Notes outline" });
    await user.click(editor);
    await user.keyboard("@Evergreen");
    const second = await screen.findByRole("option", {
      name: /Evergreen Second/,
    });

    await user.keyboard("{ArrowDown}{Enter}");

    await screen.findByRole("link", { name: "Open Evergreen Second" });
    expect(editor).toHaveFocus();
    expect(
      screen.queryByRole("option", { name: /Evergreen First/ }),
    ).toBeNull();
    expect(editor).toHaveAttribute("aria-expanded", "false");
    expect(second.id).toContain(secondId);
  });

  it("keeps the live editor doc when parent props echo a new snapshot for the same resource", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ProseMirrorOutlineEditor
        resourceKey="page:stable"
        initialDoc={emptyDoc()}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Notes outline" });
    await user.click(editor);
    await user.keyboard("local draft");

    rerender(
      <ProseMirrorOutlineEditor
        resourceKey="page:stable"
        initialDoc={textDoc("server echo")}
      />,
    );

    expect(editor).toHaveTextContent("local draft");
    expect(editor).not.toHaveTextContent("server echo");
  });

  it("hides outline handles and indentation in compact mode", async () => {
    render(
      <ProseMirrorOutlineEditor
        resourceKey="highlight:compact"
        initialDoc={emptyDoc()}
        compact
      />,
    );

    await screen.findByRole("textbox", { name: "Notes outline" });
    const handle = screen.getByLabelText("Open note block", {
      selector: "button",
    });
    const block = screen.getByRole("listitem");

    expect(getComputedStyle(handle).display).toBe("none");
    expect(getComputedStyle(block).paddingLeft).toBe("0px");
  });
});

function noteDoc(objectId: string) {
  const paragraph = outlineSchema.nodes.paragraph!.create(null, [
    outlineSchema.text("See "),
    outlineSchema.nodes.object_ref!.create({
      objectType: "media",
      objectId,
      label: "Source media",
    }),
  ]);
  const block = outlineSchema.nodes.outline_block!.create(
    { id: "block-1", collapsed: false },
    [paragraph],
  );
  return outlineSchema.nodes.outline_doc!.create(null, [block]);
}

function emptyDoc() {
  return textDoc("");
}

function textDoc(text: string) {
  const paragraph = outlineSchema.nodes.paragraph!.create();
  const body = text
    ? outlineSchema.nodes.paragraph!.create(null, outlineSchema.text(text))
    : paragraph;
  const block = outlineSchema.nodes.outline_block!.create(
    { id: "block-1", collapsed: false },
    [body],
  );
  return outlineSchema.nodes.outline_doc!.create(null, [block]);
}

function lastDocJson(onDocChange: ReturnType<typeof vi.fn>) {
  const lastCall = onDocChange.mock.calls.at(-1);
  if (!lastCall) {
    throw new Error("Expected onDocChange to have been called");
  }
  return lastCall[0].toJSON();
}

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function dropFile(target: HTMLElement, file: File) {
  const event = new DragEvent("drop", {
    bubbles: true,
    cancelable: true,
    clientX: 1,
    clientY: 1,
  });
  Object.defineProperty(event, "dataTransfer", {
    value: { files: [file] },
  });
  fireEvent(target, event);
}

function pasteText(target: HTMLElement, text: string) {
  const event = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  fireEvent(target, event);
}
