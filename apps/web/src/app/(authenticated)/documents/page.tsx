import MediaCatalogPage from "@/components/MediaCatalogPage";

export default function DocumentsPage() {
  return (
    <MediaCatalogPage
      title="Documents"
      description="All your readable sources in one place: articles, EPUBs, and PDFs."
      allowedKinds={["web_article", "epub", "pdf"]}
      emptyMessage="No documents found in your visible libraries."
    />
  );
}
