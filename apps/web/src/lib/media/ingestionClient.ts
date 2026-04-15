"use client";

import { apiFetch } from "@/lib/api/client";
import { createClient } from "@/lib/supabase/client";

type FileKind = "pdf" | "epub";

interface UploadInitResponse {
  data: {
    media_id: string;
    storage_path: string;
    token: string;
  };
}

interface IngestResponse {
  data: {
    media_id: string;
    duplicate: boolean;
  };
}

interface FromUrlResponse {
  data: {
    media_id: string;
    duplicate: boolean;
  };
}

function getFileKind(file: File): FileKind | null {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    return "pdf";
  }
  if (file.type === "application/epub+zip" || name.endsWith(".epub")) {
    return "epub";
  }
  return null;
}

function contentTypeFor(kind: FileKind): string {
  return kind === "pdf" ? "application/pdf" : "application/epub+zip";
}

export function getFileUploadError(file: File): string | null {
  const kind = getFileKind(file);
  if (!kind) {
    return "Only PDF and EPUB files are supported.";
  }

  const maxBytes = kind === "pdf" ? 100 * 1024 * 1024 : 50 * 1024 * 1024;
  if (file.size > maxBytes) {
    return `${kind.toUpperCase()} files must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.`;
  }

  return null;
}

export async function uploadIngestFile(file: File): Promise<{
  mediaId: string;
  duplicate: boolean;
}> {
  const kind = getFileKind(file);
  if (!kind) {
    throw new Error("Only PDF and EPUB files are supported.");
  }

  const init = await apiFetch<UploadInitResponse>("/api/media/upload/init", {
    method: "POST",
    body: JSON.stringify({
      kind,
      filename: file.name,
      content_type: contentTypeFor(kind),
      size_bytes: file.size,
    }),
  });

  const supabase = createClient();
  const { error } = await supabase.storage
    .from("media")
    .uploadToSignedUrl(init.data.storage_path, init.data.token, file, {
      upsert: false,
    });

  if (error) {
    throw new Error(`Upload failed: ${error.message}`);
  }

  const ingest = await apiFetch<IngestResponse>(`/api/media/${init.data.media_id}/ingest`, {
    method: "POST",
  });

  return {
    mediaId: ingest.data.media_id,
    duplicate: ingest.data.duplicate,
  };
}

export async function addMediaFromUrl(url: string): Promise<{
  mediaId: string;
  duplicate: boolean;
}> {
  const response = await apiFetch<FromUrlResponse>("/api/media/from-url", {
    method: "POST",
    body: JSON.stringify({ url }),
  });

  return {
    mediaId: response.data.media_id,
    duplicate: response.data.duplicate,
  };
}
