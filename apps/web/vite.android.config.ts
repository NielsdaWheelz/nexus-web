// Complete installed application closure. The APK serves these bytes locally;
// shared CSP generation remains the owner of executable-content policy.
// Authored reads and scope hydration use a fixed packaged SQL allowlist; renderer
// requests carry statement identities and values, never executable SQL.
import path from "node:path";
import { cpSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { Features } from "lightningcss";
import { compileQuery, compileOutlineWindows, SEARCH_INDEX_SQL, SEARCH_REMOVE_SQL, SEARCH_READ_SQL, SEARCH_MATCH_SQL, LITERAL_SOURCE_SQL, LITERAL_MISSING_SQL, LITERAL_WRITE_SQL } from "../../node/authored/src/queries";
import { SCOPE_SQL } from "../../node/authored/src/scope";
import { nativeQueryPlans } from "./src/lib/authored/nativeQuery";
import type { AuthoredQuery, WorkRegisterSource } from "../../node/authored/src/types";
import { DEVICE_SCHEMA, PENDING_CHANGES_SQL, UPGRADE_TO_6_SQL } from "../../node/authored/src/schema";
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
  // dir=auto follows the excerpt's first strong character; language is not its direction.
  css: { lightningcss: { exclude: Features.DirSelector } },
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
        writeFileSync(path.join(outDir, "authored-upgrade-to-6.json"), JSON.stringify(UPGRADE_TO_6_SQL));
        const cursor = JSON.stringify(["a0", ""]);
        const index = {start: 0, limit: 100, expected_revision: null};
        type PackagedQuery = Exclude<AuthoredQuery, {kind: "search_preview" | "search_admission"}>;
        const workDate = "2026-11-11";
        const workSamples = (source: WorkRegisterSource): PackagedQuery[] => [
          {...source, at: {kind: "describe"}, expected_revision: null},
          {...source, at: {kind: "range", start: 0, limit: 1}, expected_revision: "0"},
          {...source, at: {kind: "locate", refs: []}, expected_revision: "0"},
        ];
        const samples: Record<PackagedQuery["kind"], PackagedQuery[]> = {
          page_register: ["", "words"].flatMap<PackagedQuery>(text => [
            {kind: "page_register", text, at: {kind: "describe"}, expected_revision: null},
            {kind: "page_register", text, at: {kind: "range", start: 0, limit: 1}, expected_revision: "0"},
            {kind: "page_register", text, at: {kind: "locate", refs: []}, expected_revision: "0"},
            {kind: "page_register", text, at: {kind: "retain", token: ""}, expected_revision: "0"},
            {kind: "page_register", text, at: {kind: "held", token: "", start: 0, limit: 1}, expected_revision: "0"},
            {kind: "page_register", text, at: {kind: "successor", token: "", ref: null}, expected_revision: "0"},
            {kind: "page_register", text, at: {kind: "landing", token: "", rank: 0}, expected_revision: "0"},
            {kind: "page_register", text, at: {kind: "release", token: ""}, expected_revision: null},
          ]),
          register_label: [{kind: "register_label", ref: ""}],
          outline_filter: [{kind: "outline_filter", parent_ref: "", text: "words", start: 0, limit: 1, expected_revision: null}],
          daily_index: [
            {kind: "daily_index", arrival: "2026-11-11", retained: [], at: {kind: "describe"}, expected_revision: null},
            {kind: "daily_index", arrival: "2026-11-11", retained: [], at: {kind: "range", start: 0, limit: 1}, expected_revision: "0"},
            {kind: "daily_index", arrival: "2026-11-11", retained: [], at: {kind: "locate", dates: []}, expected_revision: "0"},
          ],
          work_pending: [...workSamples({kind:"work_pending", local_date:workDate}),
            {kind: "work_pending", local_date: workDate, at: {kind: "place", rows: []}, expected_revision: "0"}],
          work_completed: workSamples({kind:"work_completed", local_date:workDate}),
          work_row: [{kind: "work_row", ref: "", local_date: workDate}],
          habits: [
            {kind: "habits", at: {kind: "describe"}, expected_revision: null},
            {kind: "habits", at: {kind: "range", start: 0, limit: 1}, expected_revision: "0"},
            {kind: "habits", at: {kind: "locate", refs: []}, expected_revision: "0"},
          ],
          habit_days: [{kind: "habit_days", ref: "", year: 2026}],
          latest_habit_date: [{kind: "latest_habit_date"}],
          mentions: [
            {kind: "mentions", ref: "", at: {kind: "describe"}, expected_revision: null},
            {kind: "mentions", ref: "", at: {kind: "range", start: 0, limit: 1}, expected_revision: "0"},
            {kind: "mentions", ref: "", at: {kind: "locate", refs: []}, expected_revision: "0"},
          ],
          outline_windows: [
            {kind: "outline_windows", ref: "", ranges: [{start_rank: null, cursor: null, anchor_link_id: null, limit: 48}], excluded_link_ids: [], entering_link_id: null},
            {kind: "outline_windows", ref: "", ranges: [{start_rank: null, cursor, anchor_link_id: null, limit: 48}], excluded_link_ids: [], entering_link_id: null},
            {kind: "outline_windows", ref: "", ranges: [{start_rank: null, cursor: null, anchor_link_id: "", limit: 48}], excluded_link_ids: [], entering_link_id: null},
            {kind: "outline_windows", ref: "", ranges: [{start_rank: 1, cursor: null, anchor_link_id: null, limit: 48}], excluded_link_ids: [], entering_link_id: null},
          ],
          binding: [{ kind: "binding", key: { kind: "daily", local_date: "" } }, { kind: "binding", key: { kind: "link", endpoint_a: "", endpoint_b: "" } }, { kind: "binding", key: { kind: "passage", source_ref: "", normalized_exact: "", prefix: "", suffix: "" } }],
          outline_children: [{ kind: "outline_children", occurrences: [] }],
          resource: [{ kind: "resource", ref: "" }],
          excerpt: [{kind:"excerpt",ref:"",reading_ref:null}],
          source_alias: [{ kind: "source_alias", ref: "" }],
          daily: [{ kind: "daily", local_date: "" }],
          annotations: [{ kind: "annotations", source_ref: "", cursor: null, limit: 100 }],
          backlinks: [{ kind: "backlinks", ref: "", cursor: null, limit: 100 }],
          search: [{ kind: "search", text: "", cursor: null, limit: 100, scopes: [{kind: "all", id: null}], families: null }],
          adjacency: [null, cursor].map(cursor => ({ kind: "adjacency", ref: "", cursor, limit: 100 })),
          positions: [{ kind: "positions", ref: "", exclude_link_id: null, at: { kind: "tail" } }, { kind: "positions", ref: "", exclude_link_id: null, at: { kind: "neighbors", link_id: "", side: "before" } }, { kind: "positions", ref: "", exclude_link_id: null, at: { kind: "neighbors", link_id: "", side: "after" } }, { kind: "positions", ref: "", exclude_link_id: null, at: { kind: "bounds", position: "a0" } }, { kind: "positions", ref: "", exclude_link_id: null, at: { kind: "tie", position: "a0", cursor: null, limit: 100 } }],
          resolve: Array.from({ length: 101 }, (_, count) => ({ kind: "resolve", refs: Array(count).fill("") })),
        };
        const statements: Record<string, string> = { pending_changes: PENDING_CHANGES_SQL, search_index: SEARCH_INDEX_SQL, search_remove: SEARCH_REMOVE_SQL,
          literal_source: LITERAL_SOURCE_SQL, literal_missing: LITERAL_MISSING_SQL, literal_write: LITERAL_WRITE_SQL, ...SCOPE_SQL, ...SEARCH_MATCH_SQL };
        for (const sql of SEARCH_READ_SQL) statements[`search_read:${createHash("sha256").update(sql).digest("hex")}`] = sql;
        for (const query of Object.values(samples).flat()) {
          const compiled = query.kind === "outline_windows" ? compileOutlineWindows(query) : [compileQuery(query)];
          const plans = await nativeQueryPlans(query);
          for (const [index, {plan_key}] of plans.entries()) {
            const sql = compiled[index]!.sql;
            if (statements[plan_key] !== undefined && statements[plan_key] !== sql) throw new Error("native query plan collision");
            statements[plan_key] = sql;
          }
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
if(request.mode!=="navigate"||!(/^\/(?:$|share$|notes(?:\/[^/]+)?$|highlights\/[^/]+$|pages\/[^/]+$|daily(?:\/[^/]+)?$|search$|downloads$|lectern$|libraries(?:\/[^/]+)?$|browse(?:\/preview)?$|media\/[^/]+$|conversations(?:\/[^/]+)?$|podcasts(?:\/[^/]+)?$|feeds(?:\/[^/]+)?$|authors\/[^/]+$|imports$|stats$|habits$|settings(?:\/[^/]+)?$|atlas$|oracle(?:\/[^/]+)?$)/).test(url.pathname))return;
event.respondWith((async()=>{const cached=await(await caches.open(CACHE)).match("/_nexus/app/index.html");if(!cached)throw Error("offline workspace shell incomplete");const nonce=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));const html=(await cached.text()).replaceAll("__NEXUS_NONCE__",nonce);return new Response(html,{headers:{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":POLICY.replaceAll("__NEXUS_NONCE__",nonce),"Cache-Control":"no-store"}});})());});`;
}
