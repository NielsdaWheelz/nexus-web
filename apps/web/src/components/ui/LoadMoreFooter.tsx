import Button from "./Button";
import styles from "./LoadMoreFooter.module.css";

export default function LoadMoreFooter({
  hasMore,
  loading,
  disabled = false,
  onLoadMore,
  label = "Load more",
}: {
  hasMore: boolean;
  loading: boolean;
  disabled?: boolean;
  onLoadMore: () => void;
  label?: string;
}) {
  if (!hasMore) return null;
  return (
    <div className={styles.footer}>
      <Button
        variant="secondary"
        aria-busy={loading || undefined}
        aria-disabled={loading || disabled || undefined}
        onClick={() => { if (!loading && !disabled) onLoadMore(); }}
      >
        {label}
      </Button>
    </div>
  );
}
