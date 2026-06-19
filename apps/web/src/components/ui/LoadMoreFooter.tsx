"use client";

import Button from "@/components/ui/Button";
import styles from "./LoadMoreFooter.module.css";

export default function LoadMoreFooter({
  hasMore,
  loading,
  onLoadMore,
  label = "Load more",
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  label?: string;
}) {
  if (!hasMore) return null;

  return (
    <div className={styles.footer}>
      <Button
        variant="secondary"
        loading={loading}
        disabled={loading}
        onClick={onLoadMore}
      >
        {label}
      </Button>
    </div>
  );
}
