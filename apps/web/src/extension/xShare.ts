// A narrow host adapter. A trusted share invocation pins one DOM owner before X
// portals its menu. Observation lasts only for that menu; recycled or ambiguous
// owners refuse. No feed scan, private API, page-state hook or credential.
import { xTarget, type AddXCommand, type Preview } from "@/extension/capture";
import { qualifyXArticleView } from "@nexus-ingest/x_article";

interface BoundShare {
  source_url: string;
  target_url: string;
  owner: Element;
  button: Element;
  preview: Preview;
  article: boolean;
}
let invocation: { target: BoundShare; stop: () => void } | null = null;
let pendingClick: Element | null = null;
const SHARE = 'button[aria-label="Share post"],button[aria-label="Share article"],button[aria-label="Share"]';
const POST = "article";
const MENU_OPEN_MS = 2_000;
const style = document.createElement("style");
// Native focus-visible classes work without Base UI registration. Pointer hover
// otherwise depends on Base UI's private highlighted-item state.
style.textContent = '[data-nexus-share][role="menuitem"]:not([aria-disabled="true"]):hover { background-color: var(--x-hover-subtle); }';
document.head.append(style);
function own(root: Element, element: Element): boolean {
  if (element.closest(POST) !== root) return false;
  // Quoted posts use a nested link-shaped card, not necessarily another article.
  const quote = element.parentElement?.closest('[role="link"]');
  return quote === null || quote === undefined || !root.contains(quote);
}
function bound(button: Element): BoundShare | null {
  const source_url = location.href;
  const current = xTarget(source_url);
  const root = button.closest(POST);
  if (root !== null) {
    if (!own(root, button)) return null;
    // A post's timestamp link and its own reply action identify the post. Body
    // links do not: a perfectly ordinary post may link several other statuses.
    const ids = new Set<string>();
    for (const time of root.querySelectorAll('a[href] time')) {
      const anchor = time.closest<HTMLAnchorElement>('a[href]');
      if (anchor === null || !own(root, anchor)) continue;
      const target = xTarget(anchor.href);
      if (target?.kind === "status") ids.add(target.id);
    }
    const group = button.closest('[role="group"]');
    if (group !== null && own(root, group)) {
      for (const anchor of group.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        if (!own(root, anchor)) continue;
        const url = new URL(anchor.href);
        const values = url.searchParams.getAll("in_reply_to");
        if (url.protocol === "https:" && ["x.com", "twitter.com", "mobile.twitter.com"].includes(url.hostname)
          && url.pathname === "/compose/post" && values.length === 1 && /^[0-9]+$/u.test(values[0])) ids.add(values[0]);
      }
    }
    if (ids.size !== 1) return null;
    const [id] = ids;
    const anchors = [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(anchor => own(root, anchor));
    const candidates = anchors.flatMap(anchor => {
      const target = xTarget(anchor.href);
      const url = new URL(anchor.href);
      return target?.kind === "status" && target.id === id ? [url.origin + url.pathname] : [];
    });
    const urls = [...new Set(candidates)];
    if (urls.length !== 1) return null;
    const texts = [...new Set([...root.querySelectorAll('div[dir="auto"]')].filter(element => own(root, element))
      .map(element => element.textContent?.trim()).filter((value): value is string => !!value))];
    const permalink = new URL(urls[0]);
    const handle = permalink.pathname.split("/")[1].toLowerCase();
    const names = [...new Set(anchors.filter(anchor => new URL(anchor.href).origin === permalink.origin
      && new URL(anchor.href).pathname.replace(/\/$/u, "").toLowerCase() === `/${handle}`)
      .map(anchor => anchor.textContent?.trim()).filter((value): value is string => !!value && !value.startsWith("@")))];
    return { source_url, target_url: urls[0], owner: root, button, article: false,
      preview: { title: texts.length === 1 ? texts[0].slice(0, 1024) : null, byline: names.length === 1 ? names[0].slice(0, 1024) : null } };
  }
  if (current?.kind !== "article") return null;
  const view = qualifyXArticleView(document, source_url);
  const group = button.closest('[role="group"]');
  if (view === null || group === null || !view.owner.contains(group) || view.body.contains(group)
    || group.closest('[data-slot="embedded-tweet-frame"]') !== null) return null;
  const replies = [...group.querySelectorAll<HTMLAnchorElement>('a[href]')].flatMap(anchor => {
    const url = new URL(anchor.href);
    return url.origin === location.origin && url.pathname === "/compose/post"
      ? url.searchParams.getAll("in_reply_to") : [];
  });
  if (replies.length !== 1 || replies[0] !== view.carrier_id) return null;
  return { source_url, target_url: source_url, owner: view.owner, button, article: true,
    preview: { title: view.title.slice(0, 1024), byline: view.byline.slice(0, 1024) || null } };
}
function unchanged(value: BoundShare): boolean {
  if (!value.owner.isConnected || !value.button.isConnected || location.href !== value.source_url) return false;
  const fresh = bound(value.button);
  return fresh !== null && fresh.owner === value.owner && fresh.target_url === value.target_url;
}
function controlledMenu(button: Element): HTMLElement | null {
  if (button.getAttribute("aria-expanded") !== "true") return null;
  const ids = button.getAttribute("aria-controls")?.trim().split(/\s+/u) ?? [];
  if (ids.length !== 1 || !ids[0]) return null;
  const matches = document.querySelectorAll(`#${CSS.escape(ids[0])}`);
  const menu = matches[0];
  return matches.length === 1 && menu instanceof HTMLElement && menu.getAttribute("role") === "menu"
    && menu.getClientRects().length > 0 ? menu : null;
}
function begin(button: Element): void {
  if (invocation?.target.button === button && unchanged(invocation.target)) return;
  invocation?.stop();
  const target = bound(button);
  if (target === null) return;
  let menu: HTMLElement | null = null;
  let row: HTMLElement | null = null;
  let submitted = false;
  const observer = new MutationObserver(observe);
  const openingDeadline = setTimeout(() => { if (menu === null) stop(); }, MENU_OPEN_MS);
  function stop(): void {
    clearTimeout(openingDeadline);
    observer.disconnect();
    document.removeEventListener("click", outside, true);
    document.removeEventListener("keydown", keydown, true);
    window.removeEventListener("popstate", stop);
    window.removeEventListener("pagehide", stop);
    row?.remove();
    if (invocation?.stop === stop) invocation = null;
  }
  function outside(click: MouseEvent): void {
    if (!click.isTrusted || !(click.target instanceof Node) || button.contains(click.target)) return;
    if (menu === null || !menu.contains(click.target)) stop();
  }
  function keydown(key: KeyboardEvent): void {
    if (!key.isTrusted) return;
    if (key.key === "Escape" || key.key === "Tab") { stop(); return; }
    if (menu === null || !menu.contains(document.activeElement)) return;
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(item => item.getAttribute("aria-disabled") !== "true");
    const active = document.activeElement?.closest('[role="menuitem"]');
    const index = items.findIndex(item => item === active);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(key.key)) {
      key.preventDefault(); key.stopPropagation();
      const next = key.key === "Home" ? 0 : key.key === "End" ? items.length - 1
        : index < 0 ? key.key === "ArrowDown" ? 0 : items.length - 1
        : (index + (key.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (active === row && (key.key === "Enter" || key.key === " ")) {
      key.preventDefault(); key.stopPropagation(); void submit();
    }
  }
  async function submit(): Promise<void> {
    if (submitted || row === null) return;
    if (!unchanged(target!) || menu === null || controlledMenu(button) !== menu || !menu.contains(row)) { stop(); return; }
    submitted = true;
    row.setAttribute("aria-disabled", "true"); row.textContent = "saving to nexus…";
    const command: AddXCommand = { kind: "add_x", activation_id: crypto.randomUUID(), source_url: target!.source_url,
      target_url: target!.target_url, preview: target!.preview };
    try {
      const response = await browser.runtime.sendMessage(command) as { accepted: boolean; message: string | null };
      if (row.isConnected && !response.accepted) { row.textContent = response.message ?? "couldn’t start this save."; row.setAttribute("role", "status"); }
    } catch { if (row.isConnected) { row.textContent = "nexus isn’t answering. reopen this share menu."; row.setAttribute("role", "status"); } }
  }
  function observe(): void {
    if (!unchanged(target!)) { stop(); return; }
    const controlled = controlledMenu(button);
    if (menu !== null) { if (controlled !== menu || row === null || !menu.contains(row)) stop(); return; }
    if (controlled === null) return;
    const native = controlled.querySelector<HTMLElement>('[role="menuitem"]');
    if (native === null) return;
    menu = controlled;
    row = document.createElement("div");
    row.className = native.className;
    row.setAttribute("role", "menuitem"); row.tabIndex = native.tabIndex;
    row.setAttribute("data-nexus-share", "");
    row.setAttribute("aria-label", target!.article ? "add to nexus" : "add to nexus, saves the author's thread");
    const label = document.createElement("span"); label.textContent = "add to nexus";
    row.append(label);
    if (!target!.article) {
      const description = document.createElement("small"); description.textContent = "saves the author's thread";
      row.append(description);
      row.style.flexDirection = "column"; row.style.alignItems = "flex-start";
    }
    row.addEventListener("click", click => {
      if (!click.isTrusted) return;
      click.preventDefault(); click.stopPropagation(); void submit();
    });
    native.parentElement!.append(row);
  }
  invocation = { target, stop };
  document.addEventListener("click", outside, true);
  document.addEventListener("keydown", keydown, true);
  window.addEventListener("popstate", stop);
  window.addEventListener("pagehide", stop);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["style", "hidden", "id", "role", "href", "aria-expanded", "aria-controls"] });
  observe();
}
// X opens its top-level menu on mousedown or an arrow key, before (or without)
// click. Pin first; its committed ARIA relation identifies the eventual portal.
document.addEventListener("pointerdown", event => {
  if (!event.isTrusted) return;
  pendingClick = null;
  if (!event.isPrimary || event.button !== 0 || !(event.target instanceof Element)) return;
  const button = event.target.closest(SHARE);
  if (button === null) return;
  pendingClick = button;
  begin(button);
}, true);
document.addEventListener("keydown", event => {
  if (!event.isTrusted || event.repeat) return;
  pendingClick = null;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || !["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key) || !(event.target instanceof Element)) return;
  const button = event.target.closest(SHARE);
  if (button === null) return;
  if (event.key === "Enter" || event.key === " ") pendingClick = button;
  begin(button);
}, true);
document.addEventListener("click", event => {
  if (!event.isTrusted) return;
  const primed = pendingClick;
  pendingClick = null;
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  const button = event.target.closest(SHARE);
  // The native follow-up click must not restart an invocation whose owner
  // changed or whose menu closed between pointerdown/keydown and click.
  if (button === null || button === primed) return;
  begin(button);
}, true);
document.addEventListener("pointercancel", () => { pendingClick = null; }, true);
window.addEventListener("blur", () => { pendingClick = null; });
