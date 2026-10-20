// next's standalone entrypoint serves assets only from its own tree. build owns
// copying the public assets (including pdf.js) and generated chunks into it.
import { cp, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standalone = join(web, ".next/standalone");
await stat(join(standalone, "server.js"));
await cp(join(web, "public"), join(standalone, "public"), { recursive: true });
await cp(join(web, ".next/static"), join(standalone, ".next/static"), {
  recursive: true,
});
