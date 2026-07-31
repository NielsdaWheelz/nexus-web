/* eslint-disable testing-library/no-node-access -- justify-eslint-override: this browser test exercises a sandbox runtime's cross-document DOM/protocol contract, which has no parent-document semantic query surface */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildDossierFrameDocument } from "@/components/dossier/DossierDocumentFrame";

const CHANNEL = "00112233445566778899aabbccddeeff";
const NONCE = "ffeeddccbbaa99887766554433221100";

type FrameMessage = Record<string, unknown> & { kind: string };

function mountRuntime(contentHtml: string) {
  const messages: FrameMessage[] = [];
  const receive = (event: MessageEvent) => {
    if (
      event.source === frame.contentWindow &&
      typeof event.data === "object" &&
      event.data !== null
    ) {
      messages.push(event.data as FrameMessage);
    }
  };
  window.addEventListener("message", receive);
  render(
    <iframe
      title="Runtime test"
      srcDoc={buildDossierFrameDocument({
        title: "Runtime",
        contentHtml,
        theme: "light",
        nonce: NONCE,
        channel: CHANNEL,
      })}
    />,
  );
  const frame = screen.getByTitle("Runtime test") as HTMLIFrameElement;
  const send = (data: Record<string, unknown>) =>
    frame.contentWindow?.postMessage({ channel: CHANNEL, ...data }, "*");
  return {
    frame,
    messages,
    send,
    dispose: () => window.removeEventListener("message", receive),
  };
}

async function messageOf(
  messages: FrameMessage[],
  kind: string,
): Promise<FrameMessage> {
  await waitFor(() =>
    expect(messages.some((message) => message.kind === kind)).toBe(true),
  );
  return messages.find((message) => message.kind === kind)!;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("DOSSIER_DOCUMENT_RUNTIME", () => {
  it("matches canonical rendered text, excludes citations, and preserves the DOM", async () => {
    const runtime = mountRuntime(
      '<article><section id="overview"><h2>Overview</h2><p>Cafe\u0301 <span>river</span>.</p><button class="dossier-citation" data-nexus-citation="1">secret needle</button></section></article>',
    );
    await waitFor(() =>
      expect(
        runtime.frame.contentDocument?.querySelector("article"),
      ).not.toBeNull(),
    );
    const originalArticle =
      runtime.frame.contentDocument?.querySelector("article")?.innerHTML;

    runtime.send({ kind: "FindHello" });
    await messageOf(runtime.messages, "FindReady");
    runtime.send({ kind: "FindPrepare", sessionId: 1 });
    const prepared = await messageOf(runtime.messages, "FindPrepared");
    expect(prepared.projectionLengthCp).toBeGreaterThan(0);
    expect(prepared.currentSection).toEqual({
      kind: "Present",
      value: { id: "overview", title: "Overview" },
    });

    runtime.send({
      kind: "FindQuery",
      sessionId: 1,
      queryId: 1,
      query: "Café",
      scope: { kind: "EntireResource" },
      matchCase: false,
      wholeWord: false,
    });
    const results = await messageOf(runtime.messages, "FindResults");
    expect(results.result).toMatchObject({
      kind: "Ready",
      occurrences: [
        {
          ordinal: 0,
          section: {
            kind: "Present",
            value: { id: "overview", title: "Overview" },
          },
        },
      ],
    });

    runtime.send({
      kind: "FindActivate",
      sessionId: 1,
      queryId: 1,
      ordinal: 0,
    });
    expect(await messageOf(runtime.messages, "FindActivated")).toMatchObject({
      sessionId: 1,
      queryId: 1,
      ordinal: 0,
    });
    runtime.send({
      kind: "FindClear",
      sessionId: 1,
      queryId: 1,
    });
    await messageOf(runtime.messages, "FindCleared");

    runtime.send({
      kind: "FindQuery",
      sessionId: 1,
      queryId: 2,
      query: "needle",
      scope: { kind: "EntireResource" },
      matchCase: false,
      wholeWord: false,
    });
    await waitFor(() =>
      expect(
        runtime.messages.find(
          (message) =>
            message.kind === "FindResults" && message.queryId === 2,
        )?.result,
      ).toEqual({ kind: "NoMatches" }),
    );
    runtime.send({ kind: "FindReturn", sessionId: 1 });
    await messageOf(runtime.messages, "FindReturned");
    expect(
      runtime.frame.contentDocument?.querySelector("article")?.innerHTML,
    ).toBe(originalArticle);
    runtime.dispose();
  });

  it("matches the canonical punctuation, whitespace, combining-mark, astral, and CJK corpus", async () => {
    const runtime = mountRuntime(
      '<article><p>alpha<span>—</span>beta</p><p>A \t\u0085\u001c B</p><p><span>q\u0323</span><span>\u0307</span> 😀漢字</p></article>',
    );
    await waitFor(() =>
      expect(
        runtime.frame.contentDocument?.querySelector("article"),
      ).not.toBeNull(),
    );
    runtime.send({ kind: "FindPrepare", sessionId: 1 });
    await messageOf(runtime.messages, "FindPrepared");

    for (const [queryId, query] of [
      [1, "alpha—beta"],
      [2, "A B"],
      [3, "q\u0323\u0307"],
      [4, "😀漢字"],
    ] as const) {
      runtime.send({
        kind: "FindQuery",
        sessionId: 1,
        queryId,
        query,
        scope: { kind: "EntireResource" },
        matchCase: true,
        wholeWord: false,
      });
      await waitFor(() =>
        expect(
          runtime.messages.find(
            (message) =>
              message.kind === "FindResults" &&
              message.queryId === queryId,
          )?.result,
        ).toMatchObject({ kind: "Ready" }),
      );
    }
    runtime.dispose();
  });

  it("matches parent semantics for case, words, ordering, non-overlap, boundaries, scopes, and snippets", async () => {
    const runtime = mountRuntime(
      '<article><section id="scope"><h2>Scope</h2><p>Cat catfish cat cat aaaa 猫と犬 needle</p></section><p>Outside snippet context.</p><p>alpha</p><p>beta</p></article>',
    );
    await waitFor(() =>
      expect(
        runtime.frame.contentDocument?.querySelector("article"),
      ).not.toBeNull(),
    );
    runtime.send({ kind: "FindPrepare", sessionId: 1 });
    const prepared = await messageOf(runtime.messages, "FindPrepared");
    expect(prepared.currentSection).toEqual({
      kind: "Present",
      value: { id: "scope", title: "Scope" },
    });

    const query = async ({
      queryId,
      text,
      scope = { kind: "EntireResource" },
      matchCase = true,
      wholeWord = false,
    }: {
      readonly queryId: number;
      readonly text: string;
      readonly scope?: Record<string, unknown>;
      readonly matchCase?: boolean;
      readonly wholeWord?: boolean;
    }): Promise<Record<string, unknown>> => {
      runtime.send({
        kind: "FindQuery",
        sessionId: 1,
        queryId,
        query: text,
        scope,
        matchCase,
        wholeWord,
      });
      await waitFor(() =>
        expect(
          runtime.messages.some(
            (message) =>
              message.kind === "FindResults" &&
              message.queryId === queryId,
          ),
        ).toBe(true),
      );
      return runtime.messages.find(
        (message) =>
          message.kind === "FindResults" && message.queryId === queryId,
      )!.result as Record<string, unknown>;
    };

    const exactWords = await query({
      queryId: 1,
      text: "cat",
      wholeWord: true,
    });
    expect(exactWords).toMatchObject({
      kind: "Ready",
      occurrences: [
        { ordinal: 0 },
        { ordinal: 1 },
      ],
    });

    const foldedWords = await query({
      queryId: 2,
      text: "cat",
      matchCase: false,
      wholeWord: true,
    });
    expect(foldedWords).toMatchObject({
      kind: "Ready",
      occurrences: [
        { ordinal: 0 },
        { ordinal: 1 },
        { ordinal: 2 },
      ],
    });

    const nonOverlapping = await query({
      queryId: 3,
      text: "aa",
    });
    expect(nonOverlapping).toMatchObject({
      kind: "Ready",
      occurrences: [
        { ordinal: 0 },
        { ordinal: 1 },
      ],
    });
    const nonOverlappingOccurrences = nonOverlapping.occurrences as Array<{
      startCp: number;
      endCp: number;
    }>;
    expect(nonOverlappingOccurrences[1]!.startCp).toBe(
      nonOverlappingOccurrences[0]!.endCp,
    );

    expect(
      await query({
        queryId: 4,
        text: "alphabeta",
      }),
    ).toEqual({ kind: "NoMatches" });
    expect(
      await query({
        queryId: 5,
        text: "猫",
        wholeWord: true,
      }),
    ).toMatchObject({ kind: "Ready", occurrences: [{ ordinal: 0 }] });

    const scoped = await query({
      queryId: 6,
      text: "needle",
      scope: { kind: "CurrentSection", sectionId: "scope" },
    });
    expect(scoped).toMatchObject({
      kind: "Ready",
      occurrences: [{ ordinal: 0 }],
    });
    const [scopedOccurrence] = scoped.occurrences as Array<{
      snippet: Array<{ text: string; emphasized: boolean }>;
    }>;
    expect(
      scopedOccurrence!.snippet.map(({ text }) => text).join(""),
    ).not.toContain("Outside snippet context");
    expect(
      scopedOccurrence!.snippet.filter(({ emphasized }) => emphasized),
    ).toEqual([{ text: "needle", emphasized: true }]);
    runtime.dispose();
  });

  it("returns the closed cap result at 2,001 occurrences", async () => {
    const runtime = mountRuntime(
      `<article><p>${"x ".repeat(2_001)}</p></article>`,
    );
    await waitFor(() =>
      expect(
        runtime.frame.contentDocument?.querySelector("article"),
      ).not.toBeNull(),
    );
    runtime.send({ kind: "FindPrepare", sessionId: 1 });
    await messageOf(runtime.messages, "FindPrepared");
    runtime.send({
      kind: "FindQuery",
      sessionId: 1,
      queryId: 1,
      query: "x",
      scope: { kind: "EntireResource" },
      matchCase: true,
      wholeWord: true,
    });

    const results = await messageOf(runtime.messages, "FindResults");
    expect(results.result).toEqual({
      kind: "TooManyMatches",
      threshold: 2_000,
    });
    runtime.dispose();
  });

  it("omits a narrow scope when the visible section id is ambiguous", async () => {
    const runtime = mountRuntime(
      '<article><section id="duplicate"><h2>First</h2><p>Visible.</p></section><section id="duplicate"><h2>Second</h2><p>Later.</p></section></article>',
    );
    await waitFor(() =>
      expect(
        runtime.frame.contentDocument?.querySelector("article"),
      ).not.toBeNull(),
    );
    runtime.send({ kind: "FindPrepare", sessionId: 1 });

    expect(await messageOf(runtime.messages, "FindPrepared")).toMatchObject({
      currentSection: { kind: "Absent" },
    });
    runtime.dispose();
  });

  it("gates Find requests while preserving shifted shortcuts and citations", async () => {
    const runtime = mountRuntime(
      '<article><p>Readable.</p><button class="dossier-citation" data-nexus-citation="2">[2]</button></article>',
    );
    await waitFor(() =>
      expect(
        runtime.frame.contentDocument?.querySelector("article"),
      ).not.toBeNull(),
    );
    runtime.send({ kind: "FindHello" });
    await messageOf(runtime.messages, "FindReady");
    const frameWindow = runtime.frame.contentWindow!;

    const disabledFind = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      cancelable: true,
    });
    frameWindow.dispatchEvent(disabledFind);
    expect(disabledFind.defaultPrevented).toBe(false);

    runtime.send({ kind: "FindEnabled" });
    runtime.send({ kind: "FindHello" });
    await waitFor(() =>
      expect(
        runtime.messages.filter(({ kind }) => kind === "FindReady"),
      ).toHaveLength(2),
    );
    const enabledFind = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      cancelable: true,
    });
    frameWindow.dispatchEvent(enabledFind);
    expect(enabledFind.defaultPrevented).toBe(true);
    await messageOf(runtime.messages, "FindRequested");

    const shifted = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    frameWindow.dispatchEvent(shifted);
    expect(shifted.defaultPrevented).toBe(false);

    const citation = runtime.frame.contentDocument!.querySelector(
      "button.dossier-citation",
    );
    if (!citation) {
      throw new Error("Expected frame-owned citation button.");
    }
    citation.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(await messageOf(runtime.messages, "Citation")).toMatchObject({
      disposition: "Follow",
      ordinal: 2,
    });
    citation.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        detail: 1,
        shiftKey: true,
      }),
    );
    await waitFor(() =>
      expect(
        runtime.messages.filter(({ kind }) => kind === "Citation"),
      ).toHaveLength(2),
    );
    expect(
      runtime.messages.filter(({ kind }) => kind === "Citation").at(-1),
    ).toMatchObject({ disposition: "Fork", ordinal: 2 });
    runtime.dispose();
  });
});
