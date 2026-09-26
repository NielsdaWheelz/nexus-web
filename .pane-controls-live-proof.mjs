// Temporary task proof. Run against an isolated stack with ordinary sign-in.
// Delete only after the final implementation passes.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const needed = [
  "NEXUS_LIVE_BASE_URL", "NEXUS_LIVE_EMAIL", "NEXUS_LIVE_PASSWORD",
  "NEXUS_LIVE_AUTHOR_HANDLE", "NEXUS_LIVE_AUTHOR_MATCH",
  "NEXUS_PLAYWRIGHT_ENTRY",
];
const missing = needed.filter((name) => !process.env[name]);
if (missing.length) {
  console.error("BLOCKED: missing " + missing.join(", "));
  process.exit(2);
}
const base = new URL(process.env.NEXUS_LIVE_BASE_URL);
if (!["localhost", "127.0.0.1"].includes(base.hostname)) {
  console.error("BLOCKED: proof requires an isolated loopback stack");
  process.exit(2);
}
try {
  const response = await fetch(new URL("/login", base), {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("login returned " + response.status);
} catch (error) {
  console.error("BLOCKED: local web stack unavailable: " + error.message);
  process.exit(2);
}
let chromium;
try {
  ({ chromium } = await import(pathToFileURL(process.env.NEXUS_PLAYWRIGHT_ENTRY).href));
} catch (error) {
  console.error("BLOCKED: browser driver unavailable: " + error.message);
  process.exit(2);
}
let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch (error) {
  console.error("BLOCKED: chromium could not start: " + error.message);
  process.exit(2);
}
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
async function collectionAt(path) {
  await page.goto(new URL(path, base).href);
  if (new URL(page.url()).pathname === "/login") {
    throw new Error("auth session did not survive navigation to " + path);
  }
  const label = {
    "/conversations": "Filter chats",
    "/notes": "Filter pages",
    "/libraries": "Filter libraries",
    "/podcasts": "Filter followed podcasts",
    "/lectern": "Filter Lectern",
    "/search": "Search controls",
    "/browse": "Browse controls",
    "/imports": "Filter imports",
  }[new URL(path, base).pathname]
    ?? (path.startsWith("/libraries/") ? "Filter library entries"
      : path.startsWith("/podcasts/") ? "Filter podcast episodes" : "Filter works");
  const controls = page.locator(
    '[data-pane-shell="true"][data-active="true"] '
      + '[data-pane-collection-controls="true"][aria-label="' + label + '"]',
  );
  await controls.waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await controls.count(), 1, "exactly one active collection: " + label);
  return controls;
}
async function submittedSearch(term) {
  const controls = await collectionAt("/search");
  const input = controls.getByRole("textbox", { name: "Search content" });
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/search" && url.searchParams.get("q") === term;
  }, { timeout: 15000 });
  await input.fill(term);
  await page.waitForURL((url) =>
    url.pathname === "/search" && url.searchParams.get("q") === term,
    { timeout: 10000 });
  const response = await responsePromise;
  if (response.status() !== 200) {
    throw new ProofBlocked("search prerequisite returned HTTP " + response.status());
  }
  await input.press("Escape");
  assert.equal(await input.inputValue(), "", "escape clears only the draft");
  assert.equal(new URL(page.url()).searchParams.get("q"), term,
    "escape retains submitted text");
  return controls;
}
class ProofBlocked extends Error {}
const results = [];
async function check(name, run) {
  try {
    await run();
    results.push("PASS");
    console.log("PASS " + name);
  } catch (error) {
    const result = error instanceof ProofBlocked ? "BLOCKED" : "FAIL";
    results.push(result);
    console.error(result + " " + name + ": " + error.message);
  }
}
try {
  await page.goto(new URL("/login", base).href);
  await page.locator("summary").filter({ hasText: "Use email and password" }).click();
  const form = page.getByRole("form", { name: "Sign in with email and password" });
  await form.getByRole("textbox", { name: "Email" }).fill(process.env.NEXUS_LIVE_EMAIL);
  await form.locator('input[name="password"]').fill(process.env.NEXUS_LIVE_PASSWORD);
  await form.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/login", { timeout: 15000 });
  const apiReady = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === base.origin && url.pathname.startsWith("/api/")
      && response.status() === 200;
  }, { timeout: 15000 });
  await collectionAt("/lectern");
  await apiReady;
} catch (error) {
  console.error("BLOCKED: ordinary auth or real bff preflight failed: " + error.message);
  await browser.close();
  process.exit(2);
}
const author = "/authors/" + encodeURIComponent(process.env.NEXUS_LIVE_AUTHOR_HANDLE);
for (const [name, path] of [
  ["author works", author],
  ["chats", "/conversations"],
  ["pages", "/notes"],
  ["libraries", "/libraries"],
  ["library entries", process.env.NEXUS_LIVE_LIBRARY_ID
    && "/libraries/" + encodeURIComponent(process.env.NEXUS_LIVE_LIBRARY_ID)],
  ["followed podcasts", "/podcasts"],
  ["podcast episodes", process.env.NEXUS_LIVE_PODCAST_ID
    && "/podcasts/" + encodeURIComponent(process.env.NEXUS_LIVE_PODCAST_ID)],
  ["lectern", "/lectern"],
  ["search", "/search"],
  ["browse", "/browse"],
  ["imports", "/imports"],
]) {
  await check("collection route smoke: " + name, async () => {
    if (!path) throw new ProofBlocked("disposable " + name + " fixture id missing");
    const subscriptionResponse = name === "followed podcasts"
      ? page.waitForResponse((response) =>
        new URL(response.url()).pathname === "/api/podcasts/subscriptions",
      { timeout: 15000 }) : null;
    const controls = await collectionAt(path);
    if (subscriptionResponse) {
      const response = await subscriptionResponse;
      if (response.status() !== 200) {
        throw new ProofBlocked("podcast subscriptions prerequisite returned HTTP "
          + response.status() + "; isolated podcast index is disabled");
      }
    }
    const input = name === "search"
      ? controls.getByRole("textbox", { name: "Search content" })
      : controls.getByRole("searchbox").or(controls.getByRole("textbox"));
    assert.equal(await input.count(), 1, "one labelled collection input");
    assert.equal(await input.isVisible(), true, "collection input is visible");
    assert.equal(await input.evaluate((node) => document.activeElement === node), false,
      "entry does not steal focus");
  });
}
await check("wide author controls align and idle reset is absent", async () => {
  const controls = await collectionAt(author);
  const input = controls.getByRole("searchbox", { name: "Filter works" });
  const order = controls.getByRole("combobox", { name: /sort works|sort by/i });
  assert.equal(await controls.getByRole("button", { name: "Reset view" }).count(), 0,
    "default view must not show an idle reset action");
  const [inputBox, orderBox] = await Promise.all([input.boundingBox(), order.boundingBox()]);
  assert(inputBox && orderBox, "input and order must be visible");
  const delta = Math.abs(inputBox.y + inputBox.height / 2 - orderBox.y - orderBox.height / 2);
  assert(delta <= 8, "input and order belong to one compact control row; delta=" + delta);
});
await check("author keyboard search and local escape preserve input focus", async () => {
  const controls = await collectionAt(author);
  const input = controls.getByRole("searchbox", { name: "Filter works" });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Filter works");
  await input.fill(process.env.NEXUS_LIVE_AUTHOR_MATCH);
  await input.press("Escape");
  assert.equal(await input.inputValue(), "", "escape clears local text");
  assert.equal(await input.evaluate((node) => document.activeElement === node), true,
    "escape keeps focus in the local input");
});
await check("pane search shortcut targets only the active collection", async () => {
  const authorControls = await collectionAt(author);
  const authorInput = authorControls.getByRole("searchbox", { name: "Filter works" });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
  assert.equal(await authorInput.evaluate((node) => document.activeElement === node), true);
  const libraryControls = await collectionAt("/libraries");
  const inactiveAuthor = page.locator('[data-pane-shell="true"]:not([data-active="true"]) '
    + '[data-pane-collection-controls="true"][aria-label="Filter works"]')
    .getByRole("searchbox", { name: "Filter works" });
  if (await inactiveAuthor.count() === 0) {
    throw new ProofBlocked("workspace has no retained second collection pane");
  }
  await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
  const activeInput = libraryControls.getByRole("searchbox", { name: "Filter libraries" });
  await page.waitForFunction(() =>
    document.activeElement?.getAttribute("aria-label") === "Filter libraries");
  assert.equal(await activeInput.evaluate((node) => document.activeElement === node), true);
  assert.equal(await inactiveAuthor.first().evaluate((node) => document.activeElement === node),
    false, "inactive pane must not consume the shortcut");
});
await check("author sort and reset settle focus on the persistent select", async () => {
  const controls = await collectionAt(author);
  const order = controls.getByRole("combobox", { name: /sort works|sort by/i });
  const original = await order.inputValue();
  const alternatives = await order.locator("option").evaluateAll((nodes, current) =>
    nodes.map((node) => node.value).filter((value) => value !== current), original);
  assert(alternatives.length, "author sort needs another supported order");
  await order.focus();
  await order.selectOption(alternatives[0]);
  await page.waitForURL((url) => url.pathname === new URL(author, base).pathname
    && url.searchParams.has("sort"), { timeout: 10000 });
  assert.equal(await order.evaluate((node) => document.activeElement === node), true,
    "changing sort preserves focus");
  await controls.getByRole("button", { name: "Reset view" }).click();
  await page.waitForURL((url) => url.pathname === new URL(author, base).pathname
    && !url.searchParams.has("sort"), { timeout: 10000 });
  await order.waitFor({ state: "visible" });
  assert.equal(await order.inputValue(), original, "reset restores default sort");
  assert.equal(await order.evaluate((node) => document.activeElement === node), true,
    "sort-only reset returns focus to sort");
});
await check("lectern alternate sort and reset preserve authored default", async () => {
  const controls = await collectionAt("/lectern");
  const order = controls.getByRole("combobox", { name: "Sort Lectern items" });
  assert.equal(await order.inputValue(), "custom", "authored order is the default");
  assert.equal(await controls.getByRole("button", { name: "Reset view" }).count(), 0,
    "authored default has no idle reset");
  await order.focus();
  await order.selectOption("added-oldest");
  await page.waitForURL((url) => url.pathname === "/lectern"
    && url.searchParams.get("sort") === "added"
    && url.searchParams.get("direction") === "asc");
  assert.equal(await order.evaluate((node) => document.activeElement === node), true,
    "alternate sort keeps the select focused");
  await controls.getByRole("button", { name: "Reset view" }).click();
  await page.waitForURL((url) => url.pathname === "/lectern"
    && !url.searchParams.has("sort"));
  assert.equal(await order.inputValue(), "custom", "reset restores authored order");
  assert.equal(await order.evaluate((node) => document.activeElement === node), true,
    "reset returns focus to the persistent select");
});
await check("collection pane menu has no duplicate search command", async () => {
  const controls = await collectionAt(author);
  const shell = controls.locator('xpath=ancestor::*[@data-pane-shell="true"]');
  const more = shell.locator('[data-surface-header="true"]')
    .getByRole("button", { name: "More" });
  if (await more.count()) {
    await more.click();
    assert.equal(await page.getByRole("menuitem", { name: "Search this pane" }).count(), 0);
    await page.keyboard.press("Escape");
  }
});
await check("clearing a local filter announces the restored count", async () => {
  const controls = await collectionAt(author);
  const input = controls.getByRole("searchbox", { name: "Filter works" });
  const statusId = await input.getAttribute("aria-describedby");
  assert(statusId, "filter input must describe its result status");
  const visual = controls.locator('[id="' + statusId + '"]');
  await page.waitForFunction((id) => {
    const text = document.getElementById(id)?.textContent?.trim().toLowerCase() ?? "";
    const count = Number(text.match(/^(\d+)/)?.[1]);
    return count > 1 && !/loading|updating|retained|failed|unavailable/.test(text);
  }, statusId, { timeout: 15000 });
  const originalCount = Number((await visual.textContent()).trim().match(/^\d+/)?.[0]);
  assert(originalCount > 1, "fixture author needs at least two loaded works");
  await input.fill(process.env.NEXUS_LIVE_AUTHOR_MATCH);
  await page.waitForFunction(({ id, count }) => {
    const match = document.getElementById(id)?.textContent?.trim().match(/^(\d+)/);
    return match && Number(match[1]) > 0 && Number(match[1]) < count;
  }, { id: statusId, count: originalCount });
  await controls.getByRole("button", { name: "Clear text filter" }).click();
  await page.waitForFunction(({ id, count }) => {
    const text = document.getElementById(id)?.textContent?.trim() ?? "";
    return Number(text.match(/^(\d+)/)?.[1]) === count && !text.includes("matching");
  }, { id: statusId, count: originalCount });
  await page.waitForFunction(({ id, count }) => {
    const root = document.getElementById(id)?.closest('[data-pane-collection-controls="true"]');
    return [...(root?.querySelectorAll('[role="status"]') ?? [])]
      .some((node) => new RegExp("^" + count + "\\b").test(node.textContent?.trim() ?? ""));
  }, { id: statusId, count: originalCount }, { timeout: 3000 });
  assert.equal(await input.evaluate((node) => document.activeElement === node), true);
});
const library = process.env.NEXUS_LIVE_LIBRARY_ID
  && "/libraries/" + encodeURIComponent(process.env.NEXUS_LIVE_LIBRARY_ID);
await check("library facets, chip focus, clear scope, and reset", async () => {
  if (!library) throw new ProofBlocked("disposable library fixture id missing");
  const controls = await collectionAt(library);
  const input = controls.getByRole("searchbox", { name: "Filter library entries" });
  const order = controls.getByRole("combobox", { name: /sort entries/i });
  const defaultOrder = await order.inputValue();
  const alternate = await order.locator("option").evaluateAll((nodes, current) =>
    nodes.map((node) => node.value).find((value) => value !== current), defaultOrder);
  assert(alternate, "library must expose another legal order");
  await input.fill("nexus");
  await order.selectOption(alternate);
  await page.waitForURL((url) => url.pathname === library && url.searchParams.has("sort"));
  const chosenSort = new URL(page.url()).searchParams.get("sort");
  const filters = controls.getByRole("button", { name: /^filters(?:\s+\d+)?$/i });
  await filters.click();
  const editor = page.getByRole("dialog", { name: "Filters" });
  const type = editor.getByRole("combobox", { name: "Type" });
  await type.selectOption("web_article");
  await page.waitForURL((url) => url.searchParams.get("entry_type") === "web_article");
  await editor.getByRole("combobox", { name: "View" }).selectOption("in-progress");
  await page.waitForURL((url) => url.searchParams.get("projection") === "in-progress");
  const chips = controls.getByRole("group", { name: "Applied filters" });
  const removeType = chips.getByRole("button", { name: "Remove filter: Type: Web articles" });
  const removeView = chips.getByRole("button", { name: "Remove filter: View: In Progress" });
  assert.equal(await removeType.isVisible(), true, "selected type is visible");
  assert.equal(await removeView.isVisible(), true, "selected projection is visible");
  assert.match(await filters.textContent(), /2/, "badge counts structured constraints");
  await page.keyboard.press("Escape");
  await editor.waitFor({ state: "hidden" });
  assert.equal(await filters.evaluate((node) => document.activeElement === node), true,
    "nested escape returns focus to the trigger");
  assert.equal(await removeType.isVisible(), true, "escape retains applied facets");
  await removeType.click();
  await page.waitForURL((url) => !url.searchParams.has("entry_type")
    && url.searchParams.get("projection") === "in-progress");
  assert.equal(await removeView.evaluate((node) => document.activeElement === node), true,
    "removing a focused chip focuses its surviving neighbor");
  await removeView.click();
  await page.waitForURL((url) => !url.searchParams.has("projection"));
  assert.equal(await filters.evaluate((node) => document.activeElement === node), true,
    "removing the last chip returns focus to the filters trigger");
  await filters.click();
  await editor.getByRole("combobox", { name: "View" }).selectOption("in-progress");
  await page.waitForURL((url) => url.searchParams.get("projection") === "in-progress");
  await editor.getByRole("button", { name: "Clear filters" }).click();
  await page.waitForURL((url) => !url.searchParams.has("projection"));
  assert.equal(await input.inputValue(), "nexus", "clear filters preserves local text");
  assert.equal(new URL(page.url()).searchParams.get("sort"), chosenSort,
    "clear filters preserves order");
  assert.equal(await type.evaluate((node) => document.activeElement === node), true,
    "clear filters settles focus in a persistent editor field");
  await editor.getByRole("button", { name: "Reset view" }).click();
  await page.waitForURL((url) => !url.searchParams.has("sort"));
  assert.equal(await order.inputValue(), defaultOrder, "reset restores default order");
  assert.equal(await input.inputValue(), "", "reset clears local text");
  assert.equal(await filters.evaluate((node) => document.activeElement === node), true,
    "reset returns focus to the stable trigger");
});
await check("outside click closes library filters without stealing target focus", async () => {
  if (!library) throw new ProofBlocked("disposable library fixture id missing");
  const controls = await collectionAt(library);
  const input = controls.getByRole("searchbox", { name: "Filter library entries" });
  await controls.getByRole("button", { name: /^filters(?:\s+\d+)?$/i }).click();
  const editor = page.getByRole("dialog", { name: "Filters" });
  await editor.getByRole("combobox", { name: "Type" }).selectOption("pdf");
  await page.waitForURL((url) => url.searchParams.get("entry_type") === "pdf");
  await input.click();
  await editor.waitFor({ state: "hidden" });
  assert.equal(await input.evaluate((node) => document.activeElement === node), true,
    "outside click leaves focus on the target input");
  assert.equal(new URL(page.url()).searchParams.get("entry_type"), "pdf",
    "dismissing the editor keeps the applied facet");
  assert.equal(await controls.getByRole("button", { name: "Remove filter: Type: PDFs" })
    .isVisible(), true, "applied facet remains visible after dismissal");
});
await check("library count is quiet on mount and announces facet-only changes", async () => {
  if (!library) throw new ProofBlocked("disposable library fixture id missing");
  const controls = await collectionAt(library);
  const input = controls.getByRole("searchbox", { name: "Filter library entries" });
  const statusId = await input.getAttribute("aria-describedby");
  assert(statusId, "library input describes a visible result status");
  await page.waitForFunction((id) => {
    const text = document.getElementById(id)?.textContent?.trim() ?? "";
    return Number(text.match(/^(\d+) entries$/)?.[1]) >= 105;
  }, statusId, { timeout: 15000 });
  const live = controls.getByRole("status");
  await page.waitForTimeout(650);
  assert.equal((await live.textContent()).trim(), "",
    "initial settled collection count is quiet");
  await controls.getByRole("button", { name: /^filters(?:\s+\d+)?$/i }).click();
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api" + library + "/entries"
      && url.searchParams.get("entry_type") === "pdf";
  }, { timeout: 15000 });
  await page.getByRole("dialog", { name: "Filters" })
    .getByRole("combobox", { name: "Type" }).selectOption("pdf");
  const response = await responsePromise;
  if (response.status() !== 200) {
    throw new ProofBlocked("library facet prerequisite returned HTTP " + response.status());
  }
  await page.waitForFunction((id) =>
    document.getElementById(id)?.textContent?.trim() === "0 entries", statusId);
  await page.waitForFunction((id) => {
    const controls = document.getElementById(id)?.closest('[data-pane-collection-controls="true"]');
    return [...(controls?.querySelectorAll('[role="status"]') ?? [])]
      .some((node) => /^0 entries of 0 total\./.test(node.textContent?.trim() ?? ""));
  }, statusId, { timeout: 3000 });
});
await check("library pagination keeps a truthful partial count", async () => {
  if (!library) throw new ProofBlocked("disposable library fixture id missing");
  let release;
  let reached;
  const hold = new Promise((resolve) => { release = resolve; });
  const intercepted = new Promise((resolve) => { reached = resolve; });
  const routePattern = "**/api/libraries/*/entries?*";
  const pendingRoutes = [];
  await page.route(routePattern, (route) => {
    const pending = (async () => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api" + library + "/entries" && url.searchParams.has("cursor")) {
        reached();
        await hold;
      }
      await route.continue();
    })();
    pendingRoutes.push(pending);
    return pending;
  });
  try {
    const controls = await collectionAt(library + "?sort=added&direction=desc");
    await Promise.race([
      intercepted,
      new Promise((_, reject) => setTimeout(() =>
        reject(new ProofBlocked("fixture did not request a second real page")), 10000)),
    ]);
    const input = controls.getByRole("searchbox", { name: "Filter library entries" });
    const statusId = await input.getAttribute("aria-describedby");
    assert(statusId, "library input describes a visible result status");
    const status = controls.locator('[id="' + statusId + '"]');
    await page.waitForFunction((id) =>
      document.getElementById(id)?.textContent?.includes("loading more"), statusId);
    const partial = (await status.textContent()).trim();
    assert.match(partial, /^\d+ entries in \d+ loaded; loading more$/,
      "loaded rows are not presented as a final total");
    assert(Number(partial.match(/^\d+/)[0]) > 0, "first page contains real rows");
    await input.fill("nexus-library-gamma");
    await page.waitForFunction((id) =>
      document.getElementById(id)?.textContent?.trim()
        === "0 matches in 100 loaded; loading more", statusId);
  } finally {
    release();
    await Promise.allSettled(pendingRoutes);
    await page.unroute(routePattern);
  }
  const controls = page.locator('[data-pane-shell="true"][data-active="true"] '
    + '[data-pane-collection-controls="true"][aria-label="Filter library entries"]');
  const statusId = await controls.getByRole("searchbox", { name: "Filter library entries" })
    .getAttribute("aria-describedby");
  await page.waitForFunction((id) => {
    const text = document.getElementById(id)?.textContent?.trim() ?? "";
    return text === "1 of 105 entries";
  }, statusId, { timeout: 15000 });
});
await check("library second-page failure keeps rows and retries the real request", async () => {
  if (!library) throw new ProofBlocked("disposable library fixture id missing");
  let aborted = 0;
  const routePattern = "**/api/libraries/*/entries?*";
  await page.route(routePattern, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api" + library + "/entries"
        && url.searchParams.has("cursor") && aborted < 3) {
      aborted += 1;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  try {
    const controls = await collectionAt(library);
    const shell = controls.locator('xpath=ancestor::*[@data-pane-shell="true"]');
    const input = controls.getByRole("searchbox", { name: "Filter library entries" });
    const statusId = await input.getAttribute("aria-describedby");
    assert(statusId, "library input describes a visible result status");
    await page.waitForFunction((id) =>
      /^\d+ loaded; loading failed$/.test(
        document.getElementById(id)?.textContent?.trim() ?? ""),
    statusId, { timeout: 15000 });
    assert.equal(aborted, 3, "only the three ordinary transport attempts were aborted");
    const status = (await controls.locator('[id="' + statusId + '"]').textContent()).trim();
    assert.match(status, /^100 loaded; loading failed$/,
      "the failed continuation retains the first real page");
    const failure = shell.getByText("Could not finish loading —", { exact: true });
    assert.equal(await failure.isVisible(), true, "continuation exposes its retry owner");
    const responsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api" + library + "/entries"
        && url.searchParams.has("cursor") && response.status() === 200;
    }, { timeout: 15000 });
    await failure.locator('xpath=..').getByRole("button", { name: "Retry" }).click();
    await responsePromise;
    await page.waitForFunction((id) => {
      const text = document.getElementById(id)?.textContent?.trim() ?? "";
      return Number(text.match(/^(\d+) entries$/)?.[1]) >= 105;
    }, statusId, { timeout: 15000 });
  } finally {
    await page.unroute(routePattern);
  }
});
await check("library sort delays retain old rows with truthful status", async () => {
  if (!library) throw new ProofBlocked("disposable library fixture id missing");
  const controls = await collectionAt(library);
  const input = controls.getByRole("searchbox", { name: "Filter library entries" });
  const statusId = await input.getAttribute("aria-describedby");
  assert(statusId, "library input describes a visible result status");
  await page.waitForFunction((id) => {
    const text = document.getElementById(id)?.textContent?.trim() ?? "";
    return Number(text.match(/^(\d+) entries$/)?.[1]) >= 105;
  }, statusId, { timeout: 15000 });
  let release;
  let reached;
  const hold = new Promise((resolve) => { release = resolve; });
  const intercepted = new Promise((resolve) => { reached = resolve; });
  const pendingRoutes = [];
  const routePattern = "**/api/libraries/*/entries?*";
  await page.route(routePattern, (route) => {
    const pending = (async () => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api" + library + "/entries"
          && url.searchParams.has("sort") && !url.searchParams.has("cursor")) {
        reached();
        await hold;
      }
      await route.continue();
    })();
    pendingRoutes.push(pending);
    return pending;
  });
  try {
    const order = controls.getByRole("combobox", { name: "Sort entries" });
    const current = await order.inputValue();
    const next = await order.locator("option").evaluateAll((nodes, selected) =>
      nodes.map((node) => node.value).find((value) => value !== selected), current);
    assert(next, "library exposes a second order");
    await order.selectOption(next);
    await Promise.race([
      intercepted,
      new Promise((_, reject) => setTimeout(() =>
        reject(new ProofBlocked("sort did not request a real first page")), 10000)),
    ]);
    await page.waitForFunction((id) =>
      document.getElementById(id)?.textContent?.trim()
        === "updating; showing previous results", statusId, { timeout: 5000 });
  } finally {
    release();
    await Promise.allSettled(pendingRoutes);
    await page.unroute(routePattern);
  }
  await page.waitForFunction((id) => {
    const text = document.getElementById(id)?.textContent?.trim() ?? "";
    return Number(text.match(/^(\d+) entries$/)?.[1]) >= 105;
  }, statusId, { timeout: 15000 });
});
await check("wide and touch-phone controls fit their scrollport", async () => {
  const controls = await collectionAt(author);
  const wide = await controls.evaluate((node) => {
    const body = node.closest('[data-pane-content="true"]');
    const input = node.querySelector('input[data-pane-collection-input="true"]');
    const order = node.querySelector("select");
    const rect = node.getBoundingClientRect();
    const bounds = body?.getBoundingClientRect();
    return { scroll: node.scrollWidth - node.clientWidth,
      inset: bounds && [rect.left - bounds.left, bounds.right - rect.right],
      inputWidth: input?.getBoundingClientRect().width,
      orderHeight: order?.getBoundingClientRect().height };
  });
  assert(wide.inset && wide.inset.every((value) => value >= -1),
    "wide controls stay inside the body scrollport");
  assert(wide.scroll <= 1, "wide controls have no horizontal overflow");
  assert(wide.inputWidth >= 160, "wide local filter remains useful");
  await controls.locator('xpath=ancestor::*[@data-pane-shell="true"]')
    .screenshot({ path: "/private/tmp/nexus-pane-controls-wide.png" });
  const phoneContext = await browser.newContext({ viewport: { width: 320, height: 700 },
    isMobile: true, hasTouch: true, storageState: await context.storageState() });
  try {
    const phone = await phoneContext.newPage();
    await phone.goto(new URL(author, base).href);
    const small = phone.locator('[data-pane-shell="true"][data-active="true"] '
      + '[data-pane-collection-controls="true"][aria-label="Filter works"]');
    await small.waitFor({ state: "visible", timeout: 15000 });
    const geometry = await small.evaluate((node) => {
      const body = node.closest('[data-pane-content="true"]');
      const rect = node.getBoundingClientRect();
      const bounds = body?.getBoundingClientRect();
      const input = node.querySelector('input[data-pane-collection-input="true"]');
      const order = node.querySelector("select");
      return { scroll: node.scrollWidth - node.clientWidth,
        inset: bounds && [rect.left - bounds.left, bounds.right - rect.right],
        inputWidth: input?.getBoundingClientRect().width,
        inputHeight: input?.getBoundingClientRect().height,
        orderHeight: order?.getBoundingClientRect().height };
    });
    assert(geometry.inset && geometry.inset.every((value) => value >= -1),
      "phone controls stay inside the body scrollport");
    assert(geometry.scroll <= 1, "phone controls have no horizontal overflow");
    assert(geometry.inputWidth >= 112, "phone filter retains useful width");
    assert(geometry.inputHeight >= 44 && geometry.orderHeight >= 44,
      "coarse-input controls meet the 44px touch target");
    await phone.screenshot({ path: "/private/tmp/nexus-pane-controls-phone.png", fullPage: true });
    await phone.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    const zoomed = await small.getByRole("combobox", { name: "Sort works" })
      .evaluate((node) => {
        const style = getComputedStyle(node);
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) throw new Error("canvas text measurement unavailable");
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const label = node.selectedOptions[0]?.label ?? "";
        return { label, textWidth: context.measureText(label).width,
          available: node.clientWidth - parseFloat(style.paddingLeft)
            - parseFloat(style.paddingRight) };
      });
    await phone.screenshot({ path: "/private/tmp/nexus-pane-controls-phone-200pct.png",
      fullPage: true });
    assert(zoomed.label && zoomed.textWidth <= zoomed.available + 1,
      "simulated 200% text must show the full sort value: "
        + zoomed.label + " needs " + zoomed.textWidth + "px of " + zoomed.available + "px");
  } finally {
    await phoneContext.close();
  }
});
await check("submitted search stays visible when escape clears its draft", async () => {
  const controls = await submittedSearch("nexus-pane-proof");
  assert.match((await controls.textContent()).toLowerCase(), /search:\s*nexus-pane-proof/,
    "visible controls must name the still-submitted query");
});
await check("kind changes after escape preserve committed text", async () => {
  const term = "nexus-pane-proof";
  const controls = await submittedSearch(term);
  const filters = controls.getByRole("button", { name: /^filters(?:\s+\d+)?$/i });
  let editor = controls;
  if (await filters.count()) {
    await filters.click();
    editor = page.getByRole("dialog", { name: "Filters" });
  }
  await editor.getByRole("group", { name: "Result kinds" })
    .getByRole("button", { name: "Notes" }).click();
  await page.waitForURL((url) => url.pathname === "/search" && url.searchParams.has("kinds"));
  assert.equal(new URL(page.url()).searchParams.get("q"), term,
    "structured changes must retain submitted text after escape");
  assert.match((await controls.textContent()).toLowerCase(), /search:\s*nexus-pane-proof/);
});
await check("browse keeps and names a submitted query after draft escape", async () => {
  const controls = await collectionAt("/browse?kind=WebArticle&source=Nexus");
  const input = controls.getByRole("searchbox", { name: "Search" });
  const term = "nexus-pane-proof";
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/browse" && url.searchParams.get("q") === term
      && url.searchParams.get("kind") === "WebArticle"
      && url.searchParams.get("source") === "Nexus";
  }, { timeout: 15000 });
  await input.fill(term);
  await controls.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/browse"
    && url.searchParams.get("q") === term, { timeout: 10000 });
  const response = await responsePromise;
  if (response.status() !== 200) {
    throw new ProofBlocked("local browse prerequisite returned HTTP " + response.status());
  }
  await input.press("Escape");
  assert.equal(await input.inputValue(), "", "escape clears browse draft");
  assert.equal(new URL(page.url()).searchParams.get("q"), term,
    "escape retains browse submitted query");
  assert.match((await controls.textContent()).toLowerCase(), /search:\s*nexus-pane-proof/,
    "visible controls must name the submitted browse query");
});
await check("imports structured clear keeps committed text and current view", async () => {
  const controls = await collectionAt("/imports");
  const shell = controls.locator('xpath=ancestor::*[@data-pane-shell="true"]');
  await shell.getByRole("tab", { name: "History" }).click();
  await page.waitForURL((url) => url.pathname === "/imports"
    && url.searchParams.get("view") === "History"
    && url.searchParams.has("from"), { timeout: 10000 });
  const dateChip = controls.getByRole("group", { name: "Applied filters" })
    .getByText(/on or after/i);
  assert.equal(await dateChip.isVisible(), true,
    "default History date bound must be visibly applied");
  const row = shell.locator('[data-import-ref]').first();
  await row.waitFor({ state: "visible", timeout: 15000 });
  const selectedRef = await row.getAttribute("data-import-ref");
  assert(selectedRef, "fixture history contains a selectable import");
  await row.locator("button").first().click();
  await page.waitForURL((url) => url.searchParams.get("selected") === selectedRef);
  const input = controls.getByRole("searchbox", { name: "Search imports" });
  const term = "nexus-pane-proof";
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/imports" && url.searchParams.get("q") === term;
  }, { timeout: 15000 });
  await input.fill(term);
  await input.press("Enter");
  await page.waitForURL((url) => url.pathname === "/imports"
    && url.searchParams.get("q") === term, { timeout: 10000 });
  const response = await responsePromise;
  if (response.status() !== 200) {
    throw new ProofBlocked("imports prerequisite returned HTTP " + response.status());
  }
  const filters = controls.getByRole("button", { name: /^filters(?:\s+\d+)?$/i });
  await filters.click();
  const editor = page.getByRole("dialog", { name: "Filters" });
  await editor.getByRole("combobox", { name: "Type" }).selectOption("pdf");
  await page.waitForURL((url) => url.searchParams.get("media_kind") === "pdf");
  await editor.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.waitForURL((url) => !url.searchParams.has("media_kind"));
  const state = new URL(page.url()).searchParams;
  assert.equal(state.get("q"), term, "structured clear must retain committed text");
  assert.equal(state.get("view"), "History", "structured clear must retain tab");
  assert.equal(state.get("selected"), selectedRef,
    "structured clear retains inspector selection");
  assert.equal(state.has("from"), false, "structured clear removes History date bound");
  assert.equal(await input.inputValue(), term, "draft remains visible");
  assert.equal(await controls.getByRole("button", { name: "Clear all" }).count(), 0,
    "legacy Clear all action must be removed");
  await editor.getByRole("button", { name: "Reset view" }).click();
  await page.waitForURL((url) => url.searchParams.get("view") === "History"
    && url.searchParams.has("from") && !url.searchParams.has("q")
    && url.searchParams.get("selected") === selectedRef);
  assert.equal(await input.inputValue(), "", "reset clears imports search draft");
  assert.equal(await filters.evaluate((node) => document.activeElement === node), true,
    "reset returns focus to the filters trigger");
});
await check("imports continuation failure names loaded rows and retries", async () => {
  const controls = await collectionAt("/imports");
  const shell = controls.locator('xpath=ancestor::*[@data-pane-shell="true"]');
  const firstPage = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/imports"
      && url.searchParams.get("view") === "History"
      && !url.searchParams.has("cursor");
  }, { timeout: 15000 });
  await shell.getByRole("tab", { name: "History" }).click();
  const firstResponse = await firstPage;
  if (firstResponse.status() !== 200) {
    throw new ProofBlocked("imports first page returned HTTP " + firstResponse.status());
  }
  const input = controls.getByRole("searchbox", { name: "Search imports" });
  const statusId = await input.getAttribute("aria-describedby");
  assert(statusId, "imports input describes a visible result status");
  await page.waitForFunction((id) =>
    document.getElementById(id)?.textContent?.trim() === "50 of 107 imports",
  statusId, { timeout: 15000 });
  let aborted = 0;
  let markAborted;
  const abortedRequest = new Promise((resolve) => { markAborted = resolve; });
  const routePattern = "**/api/imports?*";
  await page.route(routePattern, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/imports" && url.searchParams.has("cursor")
        && aborted === 0) {
      aborted += 1;
      await route.abort("failed");
      markAborted();
      return;
    }
    await route.continue();
  });
  try {
    await shell.getByRole("button", { name: "Load more" }).click();
    await Promise.race([
      abortedRequest,
      new Promise((_, reject) => setTimeout(() =>
        reject(new ProofBlocked("imports continuation did not request a real cursor")), 10000)),
    ]);
    try {
      await page.waitForFunction((id) =>
        /50 of 107 imports.*loading failed/i.test(
          document.getElementById(id)?.textContent?.trim() ?? ""),
      statusId, { timeout: 4000 });
    } catch {
      const visible = await controls.locator('[id="' + statusId + '"]').textContent();
      throw new Error("aborted one real cursor request but status stayed: " + visible);
    }
    assert.equal(aborted, 1, "one real continuation request was transport-aborted");
    const retry = shell.getByRole("button", { name: "Retry", exact: true });
    assert.equal(await retry.count(), 1, "failed continuation has one retry owner");
    const retryResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/imports" && url.searchParams.has("cursor")
        && response.status() === 200;
    }, { timeout: 15000 });
    await retry.click();
    await retryResponse;
    await page.waitForFunction((id) =>
      document.getElementById(id)?.textContent?.trim() === "100 of 107 imports",
    statusId, { timeout: 15000 });
  } finally {
    await page.unroute(routePattern);
  }
});
await browser.close();
console.log(results.filter((result) => result === "PASS").length
  + "/" + results.length + " passed");
if (results.includes("FAIL")) process.exitCode = 1;
else if (results.includes("BLOCKED")) process.exitCode = 2;
