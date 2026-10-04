"use client";

import { apiErrorFromResponse } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";

export async function transcribeAudio(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append("audio", blob, "recording");
  form.append("content_type", blob.type || "audio/webm");

  const response = await fetch("/api/walknotes/transcribe", {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    throw await apiErrorFromResponse(response);
  }

  const body: ApiJson<"/walknotes/transcribe-audio", "post"> = await response.json();
  return body.data.transcript;
}
