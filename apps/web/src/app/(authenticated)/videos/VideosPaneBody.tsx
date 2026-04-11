"use client";

import MediaCatalogPage from "@/components/MediaCatalogPage";

export default function VideosPaneBody() {
  return (
    <MediaCatalogPage
      title="Videos"
      allowedKinds={["video"]}
      emptyMessage="No videos found in your visible libraries."
    />
  );
}
