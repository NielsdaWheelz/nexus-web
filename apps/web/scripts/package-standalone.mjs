// Build packages assets and the canonical TLS/H2 entrypoint into Next's traced
// standalone tree. The generated public HTTP/1 entrypoint is not shipped.
import { cp, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standalone = join(web, ".next/standalone");
await stat(join(standalone, "server.js"));
await cp(join(web, "public"), join(standalone, "public"), { recursive: true });
await cp(join(web, ".next/static"), join(standalone, ".next/static"), {
  recursive: true,
});
for (const name of ["serve.mjs", "probe-web.mjs"])
  await cp(join(web, "scripts", name), join(standalone, name));
await rm(join(standalone, "server.js"));
