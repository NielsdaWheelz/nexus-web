import { apiFetch } from "@/lib/api/client";

export function retryMediaSource<T = unknown>(mediaId: string): Promise<T> {
  return apiFetch<T>(`/api/media/${mediaId}/retry`, {
    method: "POST",
    body: JSON.stringify({ from_stage: "source" }),
  });
}

export function retryMediaMetadata<T = unknown>(mediaId: string): Promise<T> {
  return apiFetch<T>(`/api/media/${mediaId}/retry`, {
    method: "POST",
    body: JSON.stringify({ from_stage: "metadata" }),
  });
}
