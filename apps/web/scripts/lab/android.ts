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
  const close = async () => {
    const released = { serial: input.serial, package_name: input.package_name, package_stopped: ownsPackage, forward, reverses: [...reverses] };
    const errors: unknown[] = [];
    try { await browser?.close(); browser = null; page = null; } catch (error) { errors.push(error); }
    const results = await Promise.allSettled([
      transport.close(),
      ...(ownsPackage ? [adb("shell", "am", "force-stop", input.package_name).then(() => { ownsPackage = false; })] : []),
      ...(forward ? [adb("forward", "--remove", forward).then(() => { forward = null; })] : []),
      ...[...reverses].map(port => adb("reverse", "--remove", port).then(() => { reverses.delete(port); })),
    ]);
    errors.push(...results.flatMap(result => result.status === "rejected" ? [result.reason] : []));
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
    await expect.poll(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).ok; }
      catch { return false; }
    }, { timeout: 20_000, message: "owned android WebView devtools readiness" }).toBe(true);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20_000, noDefaults: true });
    const pages = browser.contexts()[0]?.pages() ?? [];
    const found = pages[0];
    if (pages.length !== 1 || !found) throw new Error("android lab expected one owned application WebView page");
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
      if (reachable) {
        if (!reverses.has(webPort)) {
          if ((await adb("reverse", "--list")).split(/\s+/).includes(webPort)) throw new Error("android lab web reverse port is already owned");
          await adb("reverse", webPort, `tcp:${transport.port}`); reverses.add(webPort);
        }
        transport.setReachable(true);
      } else {
        transport.setReachable(false);
        if (reverses.has(webPort)) { await adb("reverse", "--remove", webPort); reverses.delete(webPort); }
      }
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
      await browser?.close(); browser = null; page = null;
      const released_forward = forward;
      if (forward) { await adb("forward", "--remove", forward); forward = null; }
      await adb("shell", "am", "force-stop", input.package_name);
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
