// A narrow host adapter. A trusted share invocation pins one DOM owner before X
// portals its menu. Observation lasts only for that menu; recycled or ambiguous
// owners refuse. No feed scan, private API, page-state hook or credential.
import { xTarget, type AddXCommand, type Preview } from "@/extension/capture";

interface BoundShare {
  source_url: string;
  target_url: string;
  owner: Element;
  button: Element;
  preview: Preview;
  article: boolean;
}
let dismiss: (() => void) | null = null;
const SHARE = 'button[aria-label="Share post"],button[aria-label="Share article"],button[aria-label="Share"]';
const POST = 'article[data-testid="tweet"]';
const MENU_OPEN_MS = 2_000;
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
    const candidates = [...root.querySelectorAll('a[href] time')].flatMap(time => {
      const anchor = time.closest<HTMLAnchorElement>('a[href]');
      if (anchor === null || !own(root, anchor) || anchor.closest('[data-testid="User-Name"]') === null) return [];
      const target = xTarget(anchor.href);
      return target?.kind === "status" ? [new URL(anchor.href).origin + new URL(anchor.href).pathname] : [];
    });
    const urls = [...new Set(candidates)];
    if (urls.length !== 1) return null;
    const text = [...root.querySelectorAll('[data-testid="tweetText"]')].find(element => own(root, element));
    const name = [...root.querySelectorAll('[data-testid="User-Name"] a')].find(element => own(root, element));
    return { source_url, target_url: urls[0], owner: root, button, article: false,
      preview: { title: text?.textContent?.trim().slice(0, 1024) || null, byline: name?.textContent?.trim().slice(0, 1024) || null } };
  }
  if (current?.kind !== "article") return null;
  const owner = button.closest('main,[data-testid="primaryColumn"]');
  if (owner === null) return null;
  return { source_url, target_url: source_url, owner, button, article: true,
    preview: { title: owner.querySelector('h1')?.textContent?.trim().slice(0, 1024) || null, byline: null } };
}
function unchanged(value: BoundShare): boolean {
  if (!value.owner.isConnected || !value.button.isConnected || location.href !== value.source_url) return false;
  const fresh = bound(value.button);
  return fresh !== null && fresh.owner === value.owner && fresh.target_url === value.target_url;
}
function visibleMenus(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menu"]')].filter(menu => menu.getClientRects().length > 0);
}
document.addEventListener("click", event => {
  if (!event.isTrusted || event.button !== 0 || !(event.target instanceof Element)) return;
  const button = event.target.closest(SHARE);
  if (button === null) return;
  dismiss?.();
  const target = bound(button);
  if (target === null) return;
  const existing = new Set(visibleMenus());
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
    if (dismiss === stop) dismiss = null;
  }
  function outside(click: MouseEvent): void {
    if (click === event || !click.isTrusted || !(click.target instanceof Node)) return;
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
        : (index + (key.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    } else if (active === row && (key.key === "Enter" || key.key === " ")) {
      key.preventDefault(); key.stopPropagation(); void submit();
    }
  }
  async function submit(): Promise<void> {
    if (submitted || row === null) return;
    if (!unchanged(target!)) { row.textContent = "this post changed. open its share menu again."; row.setAttribute("aria-disabled", "true"); return; }
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
    if (menu !== null) { if (!menu.isConnected || menu.getClientRects().length === 0) stop(); return; }
    const candidates = visibleMenus().filter(value => !existing.has(value));
    if (candidates.length !== 1) { if (candidates.length > 1) stop(); return; }
    menu = candidates[0];
    const native = menu.querySelector<HTMLElement>('[role="menuitem"]');
    if (native === null) { menu = null; return; }
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
  dismiss = stop;
  document.addEventListener("click", outside, true);
  document.addEventListener("keydown", keydown, true);
  window.addEventListener("popstate", stop);
  window.addEventListener("pagehide", stop);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "hidden", "aria-expanded"] });
  observe();
}, true);
