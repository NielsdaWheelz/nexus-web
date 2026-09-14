import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import corpus from "../../../../../testdata/offline-reading/epub-pathnames.json";
import { normalizeEpubPathname } from "./epubHref";

/**
 * The preparation worker restates this module's normalization in
 * python/nexus/services/reader_scripts/epub_paths.mjs, and the stored
 * `href_pathname` a click resolves against is whatever that copy produced. A
 * pathname the two spell differently silently resolves to no target, so the
 * two implementations are held to the same answer on every authored shape the
 * spelling rules distinguish.
 */
const WORKER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../python/nexus/services/reader_scripts/epub_paths.mjs",
);

const HREFS: readonly string[] = [
  ...corpus.cases.map((item) => item.href),
  "Text/CHAPTER.xhtml",
  "text/chapter.xhtml",
  "Text/\u00e9cole.xhtml",
  "Text/e\u0301cole.xhtml",
  "Text/ch%61pter.xhtml",
  "Text/%C3%A9.xhtml",
  "Text/%zz.xhtml",
  "../../chapter.xhtml",
  "Text/sub/../../../deep.xhtml",
  "Text/chapter.xhtml#frag%20ment",
  "Text/chapter.xhtml#",
  "Text/chapter.xhtml?a=b&c=d#e",
  "Text/a+b.xhtml",
  "Text/a;b,c=d.xhtml",
  "Text/[bracket].xhtml",
  "Text/emoji\u{1F9E0}.xhtml",
  "Text//double.xhtml",
  "Text/.hidden",
  "Text/..x.xhtml",
  "\t Text/chapter.xhtml \n",
  "mailto:reader@epub.local",
  "HTTP://epub.local/chapter.xhtml",
  "//",
  "",
];

async function workerPathnames(hrefs: readonly string[]): Promise<readonly (string | null)[]> {
  const child = spawn(process.execPath, [WORKER], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => { if (code === 0) resolve(); else reject(new Error(`epub_paths exited with ${String(code)}`)); });
  });
  child.stdin.end(hrefs.map((href) => `${JSON.stringify(href)}\n`).join(""));
  const answers: (string | null)[] = [];
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) answers.push(JSON.parse(line));
  await exited;
  return answers;
}

it("spells EPUB lookup pathnames identically in the browser module and the preparation worker", async () => {
  const answers = await workerPathnames(HREFS);
  expect(answers, "the worker answered a different number of hrefs than it was given").toHaveLength(HREFS.length);
  for (const [index, href] of HREFS.entries()) {
    expect(answers[index], `worker and browser disagree on ${JSON.stringify(href)}`).toBe(normalizeEpubPathname(href));
  }
  for (const item of corpus.cases) {
    expect(answers[HREFS.indexOf(item.href)], `worker left the pinned corpus on ${JSON.stringify(item.href)}`).toBe(item.pathname);
  }
  expect(answers.filter((value) => value !== null).length, "the corpus exercised no resolvable pathname").toBeGreaterThan(20);
}, 20_000);
