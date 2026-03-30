"use client";

import MediaCatalogPage from "@/components/MediaCatalogPage";

export default function VideosPaneBody() {
  return (
    <MediaCatalogPage
      title="Videos"
      description="Video items from your libraries, including YouTube ingests."
      allowedKinds={["video"]}
      emptyMessage="No videos found in your visible libraries."
    />
  );
}
