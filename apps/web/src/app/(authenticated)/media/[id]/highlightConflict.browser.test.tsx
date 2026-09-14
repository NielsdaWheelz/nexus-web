import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { isApiError } from "@/lib/api/client";
import { conflictingHighlightId, createHighlight } from "@/lib/highlights/api";
import type { Highlight } from "@/lib/highlights/highlightContract";
import { useHostedTextHighlights } from "./useHostedTextHighlights";

const existingId = "00000000-0000-4000-8000-000000000001";
const existing: Highlight = {
  id: existingId,
  anchor: {
    type: "fragment_offsets", media_id: "media", fragment_id: "fragment",
    start_offset: 0, end_offset: 4,
  },
  color: "blue", exact: "text", prefix: "", suffix: "",
  created_at: "2026-09-13T00:00:00Z", updated_at: "2026-09-13T00:00:00Z",
  author_user_id: "reader", is_owner: true,
  linked_conversations: [], linked_note_blocks: [],
};

afterEach(() => vi.unstubAllGlobals());

it("recovers the addressed duplicate without rereading the fragment and retires a superseded session's late detail", async () => {
  let heldDetail: ((response: Response) => void) | null = null;
  let holdDetail = false;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "POST") return Response.json({ error: {
      code: "E_HIGHLIGHT_CONFLICT", message: "This selection already exists.",
      details: { existing_highlight_id: existingId },
    } }, { status: 409 });
    if (path === `/api/highlights/${existingId}`) {
      if (holdDetail) return new Promise<Response>((resolve) => { heldDetail = resolve; });
      return Response.json({ data: existing });
    }
    throw new Error("duplicate recovery reread the whole fragment");
  });
  const view = renderHook(() => useHostedTextHighlights({ mediaId: "media", source: { kind: "Detail", fragmentId: "fragment", highlightId: null } }));
  await waitFor(() => expect(view.result.current.status).toBe("ready"));
  let recovered: Highlight | null = null;
  await act(async () => {
    const session = view.result.current.beginMutation();
    if (session === null) throw new Error("No highlight mutation owner");
    try {
      await createHighlight("fragment", 0, 4, "yellow");
      throw new Error("Expected duplicate command rejection");
    } catch (error) {
      if (!isApiError(error)) throw error;
      const id = conflictingHighlightId(error);
      if (id === null) throw new Error("Duplicate response lost its addressed highlight");
      recovered = await view.result.current.readMutationHighlight(session, id);
    }
  });
  expect(recovered, "duplicate recovery must return the addressed existing highlight").toEqual(existing);
  expect(view.result.current.highlights).toEqual([existing]);

  // A detail read belongs to the mutation session that issued it: once a later
  // session owns the projection, the held read may neither return its row to
  // its caller nor overwrite what the current session projected.
  holdDetail = true;
  let pending: Promise<Highlight | null>;
  act(() => {
    const session = view.result.current.beginMutation();
    if (session === null) throw new Error("No highlight mutation owner");
    pending = view.result.current.readMutationHighlight(session, existingId);
  });
  await waitFor(() => expect(heldDetail).not.toBeNull());
  act(() => {
    const session = view.result.current.beginMutation();
    if (session === null) throw new Error("No highlight mutation owner");
    if (!view.result.current.projectMutation(session, () => [])) throw new Error("Superseding session could not project its write");
  });
  expect(view.result.current.highlights).toEqual([]);
  await act(async () => {
    if (heldDetail === null) throw new Error("No held external detail response");
    heldDetail(Response.json({ data: existing }));
    expect(await pending, "superseded session read returned its row to a retired caller").toBeNull();
  });
  expect(view.result.current.highlights, "superseded detail overwrote the current projection").toEqual([]);
  expect(view.result.current.status).toBe("ready");
  view.unmount();
});
