"use client";

import MediaCatalogPage from "@/components/MediaCatalogPage";

export default function DocumentsPage() {
  return (
    <MediaCatalogPage
      title="Documents"
      allowedKinds={["web_article", "epub", "pdf"]}
      emptyMessage="No documents found in your visible libraries."
    />
  );
}
