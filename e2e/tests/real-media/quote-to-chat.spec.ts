import { expect, test, type Page } from "@playwright/test";
import { readRealMediaSeed, writeRealMediaTrace } from "./real-media-seed";

async function selectFreshVisibleTextSnippet(
  page: Page,
  containerSelector: string,
  blockedExacts: string[],
): Promise<string> {
  const selected = await page.evaluate(
    ({ selector, blockedExacts: blockedValues }) => {
      const container = document.querySelector(selector);
      if (!(container instanceof HTMLElement)) {
        return null;
      }

      const blocked = new Set(
        blockedValues
          .map((value) => value.replace(/\s+/g, " ").trim())
          .filter(Boolean),
      );
      const fullText = container.innerText.replace(/\s+/g, " ").trim();
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);

      while (walker.nextNode()) {
        const textNode = walker.currentNode;
        if (!(textNode instanceof Text)) {
          continue;
        }
        const parent = textNode.parentElement;
        if (!parent || parent.closest("[data-active-highlight-ids]")) {
          continue;
        }
        const rect = parent.getBoundingClientRect();
        const style = window.getComputedStyle(parent);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          style.display === "none" ||
          style.visibility === "hidden"
        ) {
          continue;
        }

        const raw = textNode.textContent ?? "";
        for (let start = 0; start < raw.length; start += 1) {
          if (/\s/.test(raw[start] ?? "")) {
            continue;
          }
          const exact = raw.slice(start, Math.min(raw.length, start + 48)).trim();
          if (exact.length < 20 || blocked.has(exact)) {
            continue;
          }
          if (fullText.indexOf(exact) !== fullText.lastIndexOf(exact)) {
            continue;
          }

          const range = document.createRange();
          range.setStart(textNode, start);
          range.setEnd(textNode, start + exact.length);
          const selection = window.getSelection();
          if (!selection) {
            return null;
          }
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
          return selection.toString().replace(/\s+/g, " ").trim();
        }
      }

      return null;
    },
    { selector: containerSelector, blockedExacts },
  );

  if (!selected) {
    throw new Error(`Could not select fresh visible text in ${containerSelector}`);
  }
  return selected;
}

async function existingHighlightExacts(page: Page, fragmentId: string): Promise<string[]> {
  const response = await page.request.get(`/api/fragments/${fragmentId}/highlights`);
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as {
    data: { highlights: Array<{ exact?: string | null }> };
  };
  return payload.data.highlights
    .map((highlight) => highlight.exact ?? "")
    .filter(Boolean);
}

function workspacePaneButton(page: Page, name: RegExp | string) {
  return page
    .getByRole("toolbar", { name: "Workspace panes" })
    .getByRole("button", { name });
}

test("@real-media desktop selected quote opens embedded reader assistant", async ({
  page,
}, testInfo) => {
  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.web.media_id;

  const fragmentsResponse = await page.request.get(`/api/media/${mediaId}/fragments`);
  expect(fragmentsResponse.ok()).toBeTruthy();
  const fragmentsPayload = (await fragmentsResponse.json()) as {
    data: Array<{ id: string }>;
  };
  const fragmentId = fragmentsPayload.data[0]?.id;
  expect(fragmentId, `Expected readable fragment for ${mediaId}`).toBeTruthy();
  if (!fragmentId) {
    throw new Error(`Missing readable fragment for ${mediaId}`);
  }

  await page.goto(`/media/${mediaId}`);
  const contentPane = page.locator('div[class*="fragments"]');
  await expect(contentPane).toBeVisible({ timeout: 10_000 });

  const beforeExacts = await existingHighlightExacts(page, fragmentId);
  const selectedText = await selectFreshVisibleTextSnippet(
    page,
    'div[class*="fragments"]',
    beforeExacts,
  );
  const chatPaneCountBefore = await workspacePaneButton(page, /^chat\b/i).count();

  const actions = page.getByRole("dialog", { name: /highlight actions/i });
  await expect(actions.getByRole("button", { name: "Ask" })).toBeVisible({
    timeout: 5_000,
  });
  await actions.getByRole("button", { name: "Ask" }).click();

  const assistant = page.getByRole("region", { name: "Reader assistant" });
  await expect(assistant).toBeVisible({ timeout: 10_000 });
  await expect(assistant.getByLabel("Attached context")).toContainText(selectedText);
  await expect
    .poll(() => workspacePaneButton(page, /^chat\b/i).count(), { timeout: 10_000 })
    .toBe(chatPaneCountBefore);

  await page.getByRole("tab", { name: "Highlights" }).click();
  await page.getByRole("tab", { name: "Ask" }).click();
  await expect(assistant.getByLabel("Attached context")).toContainText(selectedText);

  const afterExacts = await existingHighlightExacts(page, fragmentId);
  expect(afterExacts).not.toContain(selectedText);

  writeRealMediaTrace(testInfo, "real-web-quote-to-chat-desktop-trace.json", {
    fixture_id: "web-nasa-water-on-moon",
    media_id: mediaId,
    selected_text_length: selectedText.length,
    highlight_count_before: beforeExacts.length,
    highlight_count_after: afterExacts.length,
  });
});

test("@real-media mobile selected quote opens reader assistant sheet", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });

  const seed = readRealMediaSeed();
  const mediaId = seed.fixtures.web.media_id;

  const fragmentsResponse = await page.request.get(`/api/media/${mediaId}/fragments`);
  expect(fragmentsResponse.ok()).toBeTruthy();
  const fragmentsPayload = (await fragmentsResponse.json()) as {
    data: Array<{ id: string }>;
  };
  const fragmentId = fragmentsPayload.data[0]?.id;
  expect(fragmentId, `Expected readable fragment for ${mediaId}`).toBeTruthy();
  if (!fragmentId) {
    throw new Error(`Missing readable fragment for ${mediaId}`);
  }

  await page.goto(`/media/${mediaId}`);
  const contentPane = page.locator('div[class*="fragments"]');
  await expect(contentPane).toBeVisible({ timeout: 10_000 });

  const beforeExacts = await existingHighlightExacts(page, fragmentId);
  const selectedText = await selectFreshVisibleTextSnippet(
    page,
    'div[class*="fragments"]',
    beforeExacts,
  );

  const actions = page.getByRole("dialog", { name: /highlight actions/i });
  await expect(actions.getByRole("button", { name: "Ask" })).toBeVisible({
    timeout: 5_000,
  });
  await actions.getByRole("button", { name: "Ask" }).click();

  const sheet = page.getByRole("dialog", { name: "Ask in chat" });
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  await expect(sheet.getByLabel("Attached context")).toContainText(selectedText);

  const afterExacts = await existingHighlightExacts(page, fragmentId);
  expect(afterExacts).not.toContain(selectedText);

  writeRealMediaTrace(testInfo, "real-web-quote-to-chat-mobile-trace.json", {
    fixture_id: "web-nasa-water-on-moon",
    media_id: mediaId,
    selected_text_length: selectedText.length,
    highlight_count_before: beforeExacts.length,
    highlight_count_after: afterExacts.length,
  });
});
