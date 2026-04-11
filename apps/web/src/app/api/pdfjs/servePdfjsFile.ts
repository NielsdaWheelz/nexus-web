import { readFile } from "node:fs/promises";

export async function servePdfjsFile(absolutePath: string, label: string): Promise<Response> {
  try {
    const source = await readFile(absolutePath, "utf-8");
    return new Response(source, {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    });
  } catch {
    return new Response(`${label} not available`, { status: 404 });
  }
}
