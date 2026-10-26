// Complete installed application closure. The APK serves these bytes locally;
// shared CSP generation remains the owner of executable-content policy.
import path from "node:path";
import { cpSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { compileQuery, SEARCH_INDEX_SQL, SEARCH_REMOVE_SQL } from "../../node/authored/src/queries";
import { nativeQueryPlan } from "./src/lib/authored/nativeQuery";
import type { AuthoredQuery } from "../../node/authored/src/types";
import { DEVICE_SCHEMA } from "../../node/authored/src/schema";
import { appCsp } from "./src/lib/security/csp";
import { STATIC_SECURITY_HEADERS } from "./src/lib/security/headers";
import { BRAND_BG_DARK } from "./src/lib/brand";
import { assertPdfJsRuntimeClosure, copyPdfJsRuntime } from "./scripts/copy-pdfjs.mjs";

const outDir = path.resolve(__dirname, "public/_nexus/app");
const nativeOutDir = path.resolve(__dirname, "../android/app/src/main/assets/app");
const storage = process.env.R2_S3_API_ORIGIN;
const connect = storage ? [new URL(storage).origin] : [];

export default defineConfig({
  root: path.resolve(__dirname, "src/android"),
  base: "/_nexus/app/",
  publicDir: false,
  html: { cspNonce: "__NEXUS_NONCE__" },
  define: { __NEXUS_PDF_RUNTIME_ROOT__: JSON.stringify("/_nexus/app/pdfjs") },
  resolve: { dedupe: ["yjs", "prosemirror-model", "prosemirror-state", "prosemirror-view"], alias: { "@": path.resolve(__dirname, "src") } },
  plugins: [
    react(),
    {
      name: "installed-assets",
      async writeBundle() {
        for (const directory of ["brand", "oracle-plates"])
          cpSync(path.resolve(__dirname, "public", directory), path.join(outDir, directory), { recursive: true });
        copyPdfJsRuntime(path.join(outDir, "pdfjs"));
        assertPdfJsRuntimeClosure(path.join(outDir, "pdfjs"), "the installed application");
        const entry = path.join(outDir, "index.html");
        writeFileSync(entry, readFileSync(entry, "utf8").replace("__NEXUS_CHROME__", BRAND_BG_DARK));
        writeFileSync(path.join(outDir, "security-headers.json"), JSON.stringify({
          ...Object.fromEntries(STATIC_SECURITY_HEADERS.map(header => [header.key, header.value])),
          "Content-Security-Policy": appCsp({ nonce: "__NEXUS_NONCE__", dev: false, https: false, ws: [], connect }),
        }));
        writeFileSync(path.join(outDir, "authored-schema.json"), JSON.stringify(DEVICE_SCHEMA));
        const cursor = JSON.stringify(["a0", ""]);
        const samples: Record<AuthoredQuery["kind"], AuthoredQuery[]> = {
          children: [{kind:"children",occurrences:[]}],
          binding: [{ kind: "binding", key: { kind: "daily", local_date: "" } }, { kind: "binding", key: { kind: "link", endpoint_a: "", endpoint_b: "" } }, { kind: "binding", key: { kind: "passage", source_ref: "", normalized_exact: "", prefix: "", suffix: "" } }],
          resource: [{ kind: "resource", ref: "" }],
          daily: [{ kind: "daily", local_date: "" }],
          pages: [null, cursor].map(cursor => ({ kind: "pages", cursor, limit: 100 })),
          annotations: [{ kind: "annotations", source_ref: "", cursor: null, limit: 100 }],
          annotation_notes: [{ kind: "annotation_notes", source_ref: "", cursor: null, limit: 100 }],
          backlinks: [{ kind: "backlinks", ref: "", cursor: null, limit: 100 }],
          search: [{ kind: "search", text: "", cursor: null, limit: 100 }],
          adjacency: [null, cursor].map(cursor => ({ kind: "adjacency", ref: "", cursor, limit: 100 })),
          adjacency_window: [null, cursor].map(cursor => ({ kind: "adjacency_window", ref: "", link_id: "", cursor, limit: 100 })),
          positions: [{ kind: "positions", ref: "", exclude_link_id: null, at: { kind: "tail" } }, { kind: "positions", ref: "", exclude_link_id: null, at: { kind: "neighbors", link_id: "", side: "before" } }, { kind: "positions", ref: "", exclude_link_id: null, at: { kind: "neighbors", link_id: "", side: "after" } }, { kind: "positions", ref: "", exclude_link_id: null, at: { kind: "bounds", position: "a0" } }, { kind: "positions", ref: "", exclude_link_id: null, at: { kind: "tie", position: "a0", cursor: null, limit: 100 } }],
          resolve: Array.from({ length: 101 }, (_, count) => ({ kind: "resolve", refs: Array(count).fill("") })),
        };
        const statements: Record<string, string> = { search_index: SEARCH_INDEX_SQL, search_remove: SEARCH_REMOVE_SQL };
        for (const query of Object.values(samples).flat()) {
          const { plan_key } = await nativeQueryPlan(query);
          const sql = compileQuery(query).sql;
          if (statements[plan_key] !== undefined && statements[plan_key] !== sql) throw new Error("native query plan collision");
          statements[plan_key] = sql;
        }
        writeFileSync(path.join(outDir, "authored-queries.json"), JSON.stringify(statements));
        rmSync(nativeOutDir, { recursive: true, force: true });
        mkdirSync(nativeOutDir, { recursive: true });
        cpSync(outDir, nativeOutDir, { recursive: true });
        function closure(directory: string, prefix: string): string[] {
          return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? closure(path.join(directory, entry.name), `${prefix}/${entry.name}`) : [`${prefix}/${entry.name}`]);
        }
        const assets = [...closure(outDir, "/_nexus/app"), ...closure(path.resolve(__dirname, "public/_nexus/authored"), "/_nexus/authored")].filter(asset => !asset.endsWith("security-headers.json"));
        const policy = appCsp({ nonce: "__NEXUS_NONCE__", dev: false, https: true, ws: [], connect });
        writeFileSync(path.resolve(__dirname, "public/workspace-sw.js"), serviceWorker(assets, policy));
      },
    },
  ],
  build: { outDir, emptyOutDir: true, assetsDir: "assets", sourcemap: false },
});


function serviceWorker(assets: string[], policy: string): string {
  const revision = createHash("sha256").update(assets.map(asset => readFileSync(path.join(__dirname, "public", asset))).reduce((hash, value) => hash + createHash("sha256").update(value).digest("hex"), "")).digest("hex");
  return String.raw`const CACHE=${JSON.stringify("nexus-workspace-" )}+${JSON.stringify(revision)};
const ASSETS=${JSON.stringify(assets)};
const POLICY=${JSON.stringify(policy)};
self.addEventListener("install",event=>event.waitUntil((async()=>{const cache=await caches.open(CACHE);await cache.addAll(ASSETS);})()));
self.addEventListener("activate",event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith("nexus-workspace-")&&key!==CACHE)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener("message",event=>{if(event.data?.op==="ready")event.waitUntil((async()=>{const cache=await caches.open(CACHE);const ready=(await Promise.all(ASSETS.map(asset=>cache.match(asset)))).every(Boolean);event.ports[0]?.postMessage({ready});})());});
self.addEventListener("fetch",event=>{const request=event.request,url=new URL(request.url);if(request.method!=="GET"||url.origin!==self.location.origin)return;
if(ASSETS.includes(url.pathname)){event.respondWith((async()=>{const cache=await caches.open(CACHE);return await cache.match(url.pathname)||fetch(request);})());return;}
if(request.mode!=="navigate"||!(/^\/(?:$|share$|notes(?:\/[^/]+)?$|pages\/[^/]+$|daily(?:\/[^/]+)?$|search$|downloads$|lectern$|libraries(?:\/[^/]+)?$|browse(?:\/preview)?$|media\/[^/]+$|conversations(?:\/[^/]+)?$|podcasts(?:\/[^/]+)?$|authors\/[^/]+$|imports$|stats$|settings(?:\/[^/]+)?$|atlas$|oracle(?:\/[^/]+)?$)/).test(url.pathname))return;
event.respondWith((async()=>{const cached=await(await caches.open(CACHE)).match("/_nexus/app/index.html");if(!cached)throw Error("offline workspace shell incomplete");const nonce=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));const html=(await cached.text()).replaceAll("__NEXUS_NONCE__",nonce);return new Response(html,{headers:{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":POLICY.replaceAll("__NEXUS_NONCE__",nonce),"Cache-Control":"no-store"}});})());});`;
}
