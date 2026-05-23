"use client";

import SortableList from "@/components/sortable/SortableList";
import Button from "@/components/ui/Button";
import {
  type PlaybackQueueItem,
} from "@/lib/player/playbackQueueClient";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import styles from "./GlobalPlayerFooter.module.css";

export default function GlobalPlayerQueuePanel({ onClose }: { onClose: () => void }) {
  const {
    queueItems,
    currentQueueItemId,
    playQueueItem,
    reorderQueue,
    removeFromQueue,
    clearQueue,
  } = useGlobalPlayer();

  const handlePlay = (item: PlaybackQueueItem) => {
    playQueueItem(item);
    onClose();
  };

  const handleReorder = (next: PlaybackQueueItem[]) => {
    void reorderQueue(next.map((item) => item.item_id));
  };

  return (
    <div className={styles.queueOverlay}>
      <section className={styles.queuePanel} role="dialog" aria-label="Playback queue panel">
        <header className={styles.queueHeader}>
          <h2 className={styles.queueTitle}>Playback queue</h2>
          <Button
            variant="secondary"
            size="sm"
            className={styles.queueCloseButton}
            onClick={onClose}
            aria-label="Close playback queue"
          >
            Close
          </Button>
        </header>

        {queueItems.length === 0 ? (
          <p className={styles.queueEmpty}>Queue is empty.</p>
        ) : (
          <SortableList
            className={styles.queueList}
            itemClassName={styles.queueListItem}
            items={queueItems}
            getItemId={(item) => item.item_id}
            onReorder={handleReorder}
            renderItem={({ item, handleProps }) => {
              const isCurrent = item.item_id === currentQueueItemId;
              return (
                <div className={styles.queueListItemInner} data-current={isCurrent ? "true" : "false"}>
                  <Button
                    variant="secondary"
                    size="sm"
                    className={styles.queueDragHandle}
                    aria-label={`Reorder ${item.title}`}
                    {...handleProps.attributes}
                    {...handleProps.listeners}
                  >
                    ⋮⋮
                  </Button>
                  <Button
                    variant="ghost"
                    className={styles.queueItemMain}
                    onClick={() => handlePlay(item)}
                    aria-label={`Play ${item.title} from queue`}
                  >
                    <span className={styles.queueItemTitle}>{item.title}</span>
                    <span className={styles.queueItemMeta}>
                      {item.podcast_title ?? "Unknown podcast"}
                    </span>
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    className={styles.queueItemRemoveButton}
                    aria-label={`Remove ${item.title} from queue`}
                    onClick={() => {
                      void removeFromQueue(item.item_id);
                    }}
                  >
                    Remove
                  </Button>
                </div>
              );
            }}
          />
        )}

        <footer className={styles.queueFooter}>
          <Button
            variant="secondary"
            size="sm"
            className={styles.queueClearButton}
            aria-label="Clear queue"
            onClick={() => {
              void clearQueue();
            }}
          >
            Clear queue
          </Button>
        </footer>
      </section>
    </div>
  );
}
