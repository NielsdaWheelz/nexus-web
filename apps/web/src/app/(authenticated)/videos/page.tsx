import MediaCatalogPage from "@/components/MediaCatalogPage";

export default function VideosPage() {
  return (
    <MediaCatalogPage
      title="Videos"
      description="Video items from your libraries, including YouTube ingests."
      allowedKinds={["video"]}
      emptyMessage="No videos found in your visible libraries."
    />
  );
}
