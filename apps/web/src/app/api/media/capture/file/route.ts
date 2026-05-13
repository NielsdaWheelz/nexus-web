import { proxyExtensionToFastAPI } from "@/lib/api/proxy";

export async function POST(req: Request) {
  return proxyExtensionToFastAPI(req, "/media/capture/file", {
    defaultAccept: "application/json",
    defaultContentType: "application/octet-stream",
    forwardHeaders: ["x-nexus-filename", "x-nexus-source-url"],
  });
}
