import type { Page } from "@playwright/test";

type SelectionPoint = { x: number; y: number };
type SelectionCandidate = {
  text: string;
  start: SelectionPoint;
  end: SelectionPoint;
  containerIndex: number;
  textNodeIndex: number;
  startOffset: number;
  endOffset: number;
};

export async function selectFreshVisibleTextSnippet(
  page: Page,
  containerSelector: string,
  existingExacts: string[],
  options: { method?: "drag" | "range" } = {},
): Promise<string> {
  const candidate = await page.evaluate(
    ({ selector, blockedExacts, minLength, maxLength }) => {
      const containers = Array.from(document.querySelectorAll(selector)).filter(
        (node): node is HTMLElement => node instanceof HTMLElement,
      );
      if (containers.length === 0) {
        return null;
      }

      const blocked = new Set(
        blockedExacts
          .map((value) => value.replace(/\s+/g, " ").trim())
          .filter(Boolean),
      );
      const containerText = containers
        .map((container) => container.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      const countOccurrences = (haystack: string, needle: string) => {
        let count = 0;
        let fromIndex = 0;
        while (fromIndex <= haystack.length - needle.length) {
          const matchIndex = haystack.indexOf(needle, fromIndex);
          if (matchIndex === -1) {
            break;
          }
          count += 1;
          fromIndex = matchIndex + 1;
        }
        return count;
      };

      const visibleRectForRange = (range: Range): DOMRect | null => {
        for (const rect of Array.from(range.getClientRects())) {
          if (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight
          ) {
            return rect;
          }
        }
        const rect = range.getBoundingClientRect();
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < window.innerHeight
        ) {
          return rect;
        }
        return null;
      };

      for (const [containerIndex, container] of containers.entries()) {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        let textNodeIndex = -1;
        while (walker.nextNode()) {
          const textNode = walker.currentNode;
          if (!(textNode instanceof Text)) {
            continue;
          }
          textNodeIndex += 1;

          const parent = textNode.parentElement;
          const rawText = textNode.textContent ?? "";
          if (!parent) {
            continue;
          }
          const style = window.getComputedStyle(parent);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            rawText.trim().length < minLength
          ) {
            continue;
          }

          for (let start = 0; start <= rawText.length - minLength; start += 1) {
            const current = rawText[start] ?? "";
            const previous = start > 0 ? rawText[start - 1] : " ";
            if (!/\S/.test(current) || /\S/.test(previous)) {
              continue;
            }

            for (
              let end = Math.min(rawText.length, start + maxLength);
              end >= start + minLength;
              end -= 1
            ) {
              const last = rawText[end - 1] ?? "";
              const next = end < rawText.length ? rawText[end] : " ";
              if (!/\S/.test(last) || (/\w/.test(last) && /\w/.test(next))) {
                continue;
              }

              const rawCandidate = rawText.slice(start, end);
              const normalizedCandidate = rawCandidate.replace(/\s+/g, " ").trim();
              if (
                normalizedCandidate.length < minLength ||
                blocked.has(normalizedCandidate) ||
                countOccurrences(containerText, normalizedCandidate) !== 1
              ) {
                continue;
              }

              const startRange = document.createRange();
              startRange.setStart(textNode, start);
              startRange.setEnd(textNode, Math.min(start + 1, end));
              const startRect = visibleRectForRange(startRange);
              startRange.detach();
              if (!startRect) {
                continue;
              }

              const endRange = document.createRange();
              endRange.setStart(textNode, Math.max(start, end - 1));
              endRange.setEnd(textNode, end);
              const endRect = visibleRectForRange(endRange);
              endRange.detach();
              if (!endRect) {
                continue;
              }

              return {
                text: normalizedCandidate,
                start: { x: startRect.left + 1, y: startRect.top + startRect.height / 2 },
                end: { x: endRect.right - 1, y: endRect.top + endRect.height / 2 },
                containerIndex,
                textNodeIndex,
                startOffset: start,
                endOffset: end,
              };
            }
          }
        }
      }

      return null;
    },
    { selector: containerSelector, blockedExacts: existingExacts, minLength: 20, maxLength: 48 },
  );

  if (!candidate) {
    throw new Error(`Expected to select visible text in ${containerSelector}.`);
  }
  if (options.method === "range") {
    return selectCandidateRange(page, containerSelector, candidate);
  }
  return dragSelection(page, candidate);
}

async function selectCandidateRange(
  page: Page,
  containerSelector: string,
  candidate: SelectionCandidate,
): Promise<string> {
  const selected = await page.evaluate(
    ({ selector, target }) => {
      const containers = Array.from(document.querySelectorAll(selector)).filter(
        (node): node is HTMLElement => node instanceof HTMLElement,
      );
      const container = containers[target.containerIndex];
      if (!container) {
        return "";
      }
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let textNode: Text | null = null;
      let textNodeIndex = -1;
      while (walker.nextNode()) {
        if (walker.currentNode instanceof Text) {
          textNodeIndex += 1;
          if (textNodeIndex === target.textNodeIndex) {
            textNode = walker.currentNode;
            break;
          }
        }
      }
      if (!textNode) {
        return "";
      }
      const range = document.createRange();
      range.setStart(textNode, target.startOffset);
      range.setEnd(textNode, target.endOffset);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return selection?.toString().replace(/\s+/g, " ").trim() ?? "";
    },
    { selector: containerSelector, target: candidate },
  );
  if (selected !== candidate.text) {
    throw new Error(`Selected text did not match candidate text: ${selected}`);
  }
  return selected;
}

export async function selectExactVisibleText(
  page: Page,
  containerSelector: string,
  exact: string,
): Promise<string> {
  const candidate = await page.evaluate(
    ({ selector, exact }) => {
      const container = document.querySelector(selector);
      if (!(container instanceof HTMLElement)) {
        return null;
      }
      const visibleRectForRange = (range: Range): DOMRect | null => {
        const rect = range.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? rect : null;
      };
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const textNode = walker.currentNode;
        const text = textNode.textContent ?? "";
        const start = text.indexOf(exact);
        if (start < 0) {
          continue;
        }
        const end = start + exact.length;
        const startRange = document.createRange();
        startRange.setStart(textNode, start);
        startRange.setEnd(textNode, Math.min(start + 1, end));
        const startRect = visibleRectForRange(startRange);
        startRange.detach();
        const endRange = document.createRange();
        endRange.setStart(textNode, Math.max(start, end - 1));
        endRange.setEnd(textNode, end);
        const endRect = visibleRectForRange(endRange);
        endRange.detach();
        if (!startRect || !endRect) {
          continue;
        }
        return {
          text: exact,
          start: { x: startRect.left + 1, y: startRect.top + startRect.height / 2 },
          end: { x: endRect.right - 1, y: endRect.top + endRect.height / 2 },
        };
      }
      return null;
    },
    { selector: containerSelector, exact },
  );
  if (!candidate) {
    throw new Error(`Could not find selected text: ${exact}`);
  }
  return dragSelection(page, candidate);
}

async function dragSelection(page: Page, candidate: SelectionCandidate): Promise<string> {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.mouse.move(candidate.start.x, candidate.start.y);
  await page.mouse.down();
  await page.mouse.move(candidate.end.x, candidate.end.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(
    () =>
      Boolean(window.getSelection()?.toString().replace(/\s+/g, " ").trim()) ||
      Boolean(
        document.querySelector(
          '[role="group"][aria-label="Selection actions"], [role="group"][aria-label="Assistant answer selection"]',
        ),
      ),
    null,
    { timeout: 5_000 },
  );
  const selected = await page.evaluate(
    () => window.getSelection()?.toString().replace(/\s+/g, " ").trim() ?? "",
  );
  if (!selected) {
    return candidate.text;
  }
  if (
    selected !== candidate.text &&
    !selected.includes(candidate.text) &&
    !candidate.text.includes(selected)
  ) {
    throw new Error(`Selected text did not match candidate text: ${selected}`);
  }
  return selected;
}
