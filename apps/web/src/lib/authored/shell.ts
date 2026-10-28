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
