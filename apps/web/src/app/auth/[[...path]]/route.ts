import { NextResponse } from "next/server";
import { finish } from "@/lib/auth/session";

// this namespace owns unknown auth paths before the workspace root catch-all.
function notFound() {
  return finish(
    new NextResponse("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }),
  );
}

export const GET = notFound;
export const HEAD = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
