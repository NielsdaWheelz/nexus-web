"use client";

interface TranscribeResponse {
  data: {
    transcript: string;
    duration_ms: number | null;
  };
}

export async function transcribeAudio(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append("audio", blob, "recording");
  form.append("content_type", blob.type || "audio/webm");
  form.append("max_duration_seconds", "120");

  const response = await fetch("/api/walknotes/transcribe", {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    const code = body?.error?.code ?? "E_TRANSCRIBE_FAILED";
    const message = body?.error?.message ?? "Transcription failed";
    throw Object.assign(new Error(message), { code, status: response.status });
  }

  const json = (await response.json()) as TranscribeResponse;
  return json.data.transcript;
}
