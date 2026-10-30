/** Readiness requires the service worker's complete explicit shell closure. */
export async function prepareShell(): Promise<void> {
  if (!("serviceWorker" in navigator)) throw new Error("offline workspace requires service worker support");
  const registration = await navigator.serviceWorker.register("/workspace-sw.js", { scope: "/", updateViaCache: "none" });
  const worker = registration.active ?? registration.installing ?? registration.waiting;
  if (!worker) throw new Error("offline workspace shell is unavailable");
  if (worker.state !== "activated") await new Promise<void>((resolve, reject) => {
    const changed = () => { if (worker.state === "activated") { worker.removeEventListener("statechange", changed); resolve(); } else if (worker.state === "redundant") { worker.removeEventListener("statechange", changed); reject(new Error("offline workspace shell installation failed")); } };
    worker.addEventListener("statechange", changed); changed();
  });
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error("offline workspace shell did not confirm readiness")); }, 30_000);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); if (event.data?.ready === true) resolve(); else reject(new Error("offline workspace shell is incomplete")); };
    worker.postMessage({ op: "ready" }, [channel.port2]);
  });
}

/** Report a completely installed update. Natural activation waits for every old
 * tab to close, preserving its document and shared-worker asset closure. */
export function observeShellUpdate(changed: (waiting: boolean) => void): () => void {
  let live = true;
  let registration: ServiceWorkerRegistration | null = null;
  let workers: ServiceWorker[] = [];
  const observe = () => {
    for (const worker of workers) worker.removeEventListener("statechange", observe);
    workers = registration ? [registration.installing, registration.waiting].filter(worker => worker !== null) : [];
    for (const worker of workers) worker.addEventListener("statechange", observe);
    changed(registration?.waiting?.state === "installed");
  };
  void navigator.serviceWorker.getRegistration("/").then(value => {
    if (!live || !value) return;
    registration = value;
    registration.addEventListener("updatefound", observe);
    observe();
  }).catch(error => { if (live) reportError(error); });
  return () => {
    live = false;
    registration?.removeEventListener("updatefound", observe);
    for (const worker of workers) worker.removeEventListener("statechange", observe);
  };
}
