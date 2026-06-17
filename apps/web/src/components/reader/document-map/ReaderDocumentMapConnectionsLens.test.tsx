import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderConnectionRow } from "@/lib/reader/documentMap";
import type {
  ConnectionEndpointOut,
  ConnectionOut,
} from "@/lib/resourceGraph/connections";
import ReaderDocumentMapConnectionsLens from "./ReaderDocumentMapConnectionsLens";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";
const SPAN_ID = "33333333-3333-4333-8333-333333333333";
const FRAGMENT_ID = "44444444-4444-4444-8444-444444444444";

function endpoint(ref: string, label: string, href: string | null): ConnectionEndpointOut {
  const [scheme, id] = ref.split(":") as [ConnectionEndpointOut["scheme"], string];
  return { ref, scheme, id, label, description: null, href, missing: href === null };
}

function connection(overrides: Partial<ConnectionOut> = {}): ConnectionOut {
  const source = endpoint(`message:${MESSAGE_ID}`, "Assistant answer", `/conversations/${MESSAGE_ID}`);
  const target = endpoint(`evidence_span:${SPAN_ID}`, "Cited passage", `/media/${MEDIA_ID}#evidence-${SPAN_ID}`);
  return {
    edge_id: "edge-1",
    direction: "incoming",
    kind: "supports",
    origin: "citation",
    snapshot: null,
    source_order_key: null,
    target_order_key: null,
    ordinal: 1,
    source_ref: source.ref,
    target_ref: target.ref,
    source,
    target,
    other: source,
    citation: {
      ordinal: 1,
      role: "supports",
      snapshot: { excerpt: "Quoted passage." },
      target_reader: null,
      target_status: "current",
    },
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function row(overrides: Partial<ReaderConnectionRow> = {}): ReaderConnectionRow {
  return {
    id: "edge:edge-1:anchor:evidence_span",
    connection: connection(),
    anchor: {
      ref: `evidence_span:${SPAN_ID}`,
      media_id: MEDIA_ID,
      locator: {
        type: "web_text_offsets",
        media_id: MEDIA_ID,
        fragment_id: FRAGMENT_ID,
        start_offset: 10,
        end_offset: 24,
      },
      page_number: null,
      fragment_id: FRAGMENT_ID,
      highlight_id: null,
      evidence_span_id: SPAN_ID,
      order_key: "fragment:0000000001:0000000010",
    },
    source_category: "chat",
    title: "Assistant answer",
    subtitle: "citation · supports",
    excerpt: "Quoted passage.",
    href: `/conversations/${MESSAGE_ID}`,
    ...overrides,
  };
}

describe("ReaderDocumentMapConnectionsLens", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the source object and activates an anchored target", () => {
    const onOpenSource = vi.fn();
    const onActivateTarget = vi.fn();
    const item = row();
    render(
      <ReaderDocumentMapConnectionsLens
        rows={[item]}
        loading={false}
        error={null}
        contentRef={{ current: document.createElement("div") }}
        measureKey="test"
        isMobile
        onOpenSource={onOpenSource}
        onActivateTarget={onActivateTarget}
      />,
    );

    fireEvent.click(screen.getByText("Assistant answer"));
    expect(onOpenSource).toHaveBeenCalledWith(item, expect.any(Object));

    fireEvent.click(screen.getByRole("button", { name: /Open target in reader/ }));
    expect(onActivateTarget).toHaveBeenCalledWith(item);
  });

  it("shows non-jumpable citation status without a target button", () => {
    render(
      <ReaderDocumentMapConnectionsLens
        rows={[
          row({
            anchor: null,
            connection: connection({
              citation: {
                ordinal: 1,
                role: "supports",
                snapshot: { excerpt: "Quoted passage." },
                target_reader: null,
                target_status: "unanchorable",
              },
            }),
          }),
        ]}
        loading={false}
        error={null}
        contentRef={{ current: document.createElement("div") }}
        measureKey="test"
        isMobile
        onOpenSource={vi.fn()}
        onActivateTarget={vi.fn()}
      />,
    );

    expect(screen.getByText("Target is not jumpable in this reader.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Open target in reader/ })).toBeNull();
  });
});
