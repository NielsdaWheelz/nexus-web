// one explicitly owned disposable nexus package on one serial. the caller owns
// the paired apk, account, login and input scenario. this owner installs no
// companion driver and touches only its package and newly allocated mappings.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { openLabWebTransport } from "./transport";

export interface AndroidLabRelease {
  serial: string; package_name: string; package_stopped: boolean;
  forward: string | null; reverses: string[];
}

export async function openLabAndroid(input: {
  adb_file: string; aapt_file: string; serial: string; package_name: string;
  apk_file: string; web_origin: string; storage_origin: string;
}): Promise<{
  /** Observe the owned app’s expected rendered entry through native accessibility
   * before attachment. An owned URL can precede a live renderer. */
  attachPage(): Promise<Page>; close(): Promise<AndroidLabRelease>;
  setWebReachable(reachable: boolean): Promise<void>;
  /** Relaunch with retained app data; previous_pid is null if the package already exited. */
  restart(pathname: string): Promise<{ page: Page; previous_pid: string | null; pid: string; released_forward: string | null }>;
}> {
  const run = promisify(execFile);
  const adb = async (...args: string[]) => (await run(input.adb_file, ["-s", input.serial, ...args], { timeout: 30_000 })).stdout.trim();
  const metadata = (await run(input.aapt_file, ["dump", "badging", input.apk_file])).stdout;
  if (/^package: name='([^']+)'/m.exec(metadata)?.[1] !== input.package_name)
    throw new Error("android lab apk does not match the explicitly owned package");
  const ports = [...new Set([input.web_origin, input.storage_origin].map(value => {
    const origin = new URL(value);
    if (origin.origin !== value || origin.hostname !== "127.0.0.1" || !origin.port)
      throw new Error("android lab requires exact loopback origins with explicit ports");
    return `tcp:${origin.port}`;
  }))];
  const existing = new Set((await adb("reverse", "--list")).split(/\s+/));
  if (ports.some(port => existing.has(port))) throw new Error("android lab reverse port is already owned");
  const webPort = `tcp:${new URL(input.web_origin).port}`;
  const transport = await openLabWebTransport(Number(new URL(input.web_origin).port));
  const reverses = new Set<string>();
  let forward: string | null = null;
  let ownsPackage = false;
  let browser: Browser | null = null;
  let page: Page | null = null;
  const disconnectBrowser = async () => {
    page = null;
    if (browser === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        browser.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("android lab CDP disconnect timed out; browser release unconfirmed")), 5000);
        }),
      ]);
      browser = null;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };
  const close = async () => {
    const released = { serial: input.serial, package_name: input.package_name, package_stopped: ownsPackage, forward, reverses: [...reverses] };
    const errors: unknown[] = [];
    if (ownsPackage) {
      try { await adb("shell", "am", "force-stop", input.package_name); ownsPackage = false; }
      catch (error) { errors.push(error); }
    }
    const results = await Promise.allSettled([
      transport.close(),
      ...(forward ? [adb("forward", "--remove", forward).then(() => { forward = null; })] : []),
      ...(!ownsPackage ? [...reverses].map(port => adb("reverse", "--remove", port).then(() => { reverses.delete(port); })) : []),
    ]);
    errors.push(...results.flatMap(result => result.status === "rejected" ? [result.reason] : []));
    if (ownsPackage && reverses.size) errors.push(new Error(`android lab retained reverse mappings after package stop failed: ${[...reverses].join(", ")}`));
    try { await disconnectBrowser(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "android lab owned cleanup failed");
    return released;
  };
  const attachPage = async (): Promise<Page> => {
    if (page) return page;
    const pid = (await adb("shell", "pidof", input.package_name)).split(" ")[0] ?? "";
    if (!/^\d+$/.test(pid)) throw new Error("android lab owned process is missing");
    const port = await adb("forward", "tcp:0", `localabstract:webview_devtools_remote_${pid}`);
    if (!/^\d+$/.test(port)) throw new Error("android lab forward did not publish a port");
    forward = `tcp:${port}`;
    // justify-polling: devtools has no pre-CDP target notification; retain the bounded startup cadence.
    await expect.poll(async () => {
      let targets: unknown;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
        if (!response.ok) return { http_status: response.status };
        targets = await response.json();
      } catch (error) {
        // report malformed protocol data without echoing titles, urls or authentication material.
        if (error instanceof SyntaxError) throw new Error("android lab owned WebView target list is not valid JSON");
        // justify-ignore-error: connection startup and this request's timeout are bounded readiness failures.
        if (error instanceof TypeError || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")))
          return { reachable: false };
        throw error;
      }
      if (!Array.isArray(targets)) throw new Error("android lab owned WebView target list is not an array");
      const urls: string[] = [];
      for (const target of targets) {
        if (typeof target !== "object" || target === null || typeof target.type !== "string")
          throw new Error("android lab owned WebView target has no type");
        if (target.type !== "page") continue;
        if (typeof target.url !== "string") throw new Error("android lab owned WebView page target has no URL");
        urls.push(target.url);
      }
      return { targets: targets.length, pages: urls.length,
        owned_pages: urls.filter(url => URL.canParse(url) && new URL(url).origin === input.web_origin).length };
    }, { timeout: 20_000, intervals: [100, 250, 500, 1000], message: `owned android WebView page readiness (pid ${pid}, forward ${forward})` })
      .toMatchObject({ pages: 1, owned_pages: 1 });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20_000, noDefaults: true });
    let contexts = browser.contexts();
    if (contexts.length === 1 && contexts[0].pages().length === 0) {
      await contexts[0].waitForEvent("page", { timeout: 20_000 });
      contexts = browser.contexts();
    }
    const pageCounts = contexts.map(context => context.pages().length);
    const pages = contexts.length === 1 ? contexts[0].pages() : [];
    const found = pages[0];
    const ownedOrigin = found !== undefined && URL.canParse(found.url()) && new URL(found.url()).origin === input.web_origin;
    if (contexts.length !== 1 || pages.length !== 1 || !found || !ownedOrigin)
      throw new Error(`android lab expected one owned application WebView page (pid ${pid}, forward ${forward}, contexts ${contexts.length}, pages [${pageCounts.join(", ")}], owned origin ${ownedOrigin})`);
    page = found;
    return page;
  };
  try {
    for (const port of ports) { await adb("reverse", port, port === webPort ? `tcp:${transport.port}` : port); reverses.add(port); }
    ownsPackage = true;
    await adb("install", "-r", input.apk_file);
    if (await adb("shell", "pm", "clear", input.package_name) !== "Success")
      throw new Error("android lab could not clear its disposable package");
    await adb("shell", "am", "start", "-W", "-n", `${input.package_name}/app.nexus.android.MainActivity`);
    return { close, attachPage, setWebReachable: async reachable => {
      transport.setReachable(reachable);
    }, restart: async pathname => {
      const target = new URL(pathname, input.web_origin);
      if (!pathname.startsWith("/") || target.origin !== input.web_origin) throw new Error("android lab restart requires an owned application path");
      let previous_pid: string | null = null;
      try {
        previous_pid = (await adb("shell", "pidof", input.package_name)).split(" ")[0] ?? "";
        if (!/^[1-9]\d*$/.test(previous_pid)) throw new Error("android lab owned process returned an invalid pid");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === 1 &&
          "stdout" in error && error.stdout === "" && "stderr" in error && error.stderr === "")) throw error;
      }
      const released_forward = forward;
      const results = await Promise.allSettled([
        ...(forward ? [adb("forward", "--remove", forward).then(() => { forward = null; })] : []),
        adb("shell", "am", "force-stop", input.package_name),
      ]);
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      try { await disconnectBrowser(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "android lab restart cleanup failed");
      await adb("shell", "am", "start", "-W", "-n", `${input.package_name}/app.nexus.android.MainActivity`, "-a", "android.intent.action.VIEW", "-d", `'${target.href.replaceAll("'", "'\\''")}'`);
      const reopened = await attachPage();
      const pid = (await adb("shell", "pidof", input.package_name)).split(" ")[0] ?? "";
      if (!/^[1-9]\d*$/.test(pid)) throw new Error("android lab restarted process is missing");
      if (previous_pid !== null && pid === previous_pid) throw new Error("android lab restart retained the previous process");
      return { page: reopened, previous_pid, pid, released_forward };
    } };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "android lab setup and cleanup failed"); }
    throw error;
  }
}
