"use client";

import MediaCatalogPage from "@/components/MediaCatalogPage";

export default function VideosPage() {
  return (
    <MediaCatalogPage
      title="Videos"
      allowedKinds={["video"]}
      emptyMessage="No videos found in your visible libraries."
    />
  );
}
