// Renders the API's wire schema (`python -m nexus.wire_schema`) to TypeScript:
// src/lib/api/wire.gen.ts, or the path given as the one argument.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2] ?? join(webDir, "src/lib/api/wire.gen.ts");

const schema = execFileSync(
  "uv",
  ["run", "--frozen", "--no-sync", "python", "-m", "nexus.wire_schema"],
  {
    cwd: join(webDir, "../../python"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  },
);
const ast = await openapiTS(JSON.parse(schema), { silent: true });
writeFileSync(
  output,
  "// GENERATED from the FastAPI wire schema by scripts/gen-wire.mjs; do not edit.\n" +
    "// Regenerate: cd apps/web && bun run gen:wire\n\n" +
    astToString(ast),
);
