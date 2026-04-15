import { NextResponse } from "next/server";

export async function DELETE(req: Request) {
  const requestId = req.headers.get("x-request-id") || crypto.randomUUID();
  const authorization = req.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return NextResponse.json(
      {
        error: {
          code: "E_UNAUTHENTICATED",
          message: "Extension token required",
          request_id: requestId,
        },
      },
      { status: 401, headers: { "X-Request-ID": requestId } }
    );
  }

  try {
    const response = await fetch(
      `${process.env.FASTAPI_BASE_URL || "http://localhost:8000"}/auth/extension-sessions/current`,
      {
        method: "DELETE",
        headers: {
          Authorization: authorization,
          "X-Request-ID": requestId,
          ...(process.env.NEXUS_INTERNAL_SECRET
            ? { "X-Nexus-Internal": process.env.NEXUS_INTERNAL_SECRET }
            : {}),
        },
        signal: req.signal,
      }
    );

    if (response.status === 204) {
      return new Response(null, {
        status: 204,
        headers: { "X-Request-ID": response.headers.get("x-request-id") || requestId },
      });
    }

    return new Response(await response.text(), {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": response.headers.get("content-type") || "application/json",
        "X-Request-ID": response.headers.get("x-request-id") || requestId,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    console.error("Extension session revoke proxy error:", error);
    return NextResponse.json(
      {
        error: {
          code: "E_INTERNAL",
          message: "Backend service unavailable",
          request_id: requestId,
        },
      },
      { status: 503, headers: { "X-Request-ID": requestId } }
    );
  }
}
