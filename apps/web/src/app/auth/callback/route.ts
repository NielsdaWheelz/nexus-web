import { handleAuthCallback } from "@/lib/auth/callback";

export async function GET(request: Request) {
  return handleAuthCallback(request);
}
