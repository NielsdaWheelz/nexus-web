"use client";

import Link from "next/link";
import { useId, useMemo, useRef } from "react";
import SortableList from "@/components/sortable/SortableList";
import Button from "@/components/ui/Button";
import { isAudioQueueItem } from "@/lib/player/consumptionQueueClient";
import { useGlobalPlayer } from "@/lib/player/globalPlayer";
import { useDialogOverlay } from "@/lib/ui/useDialogOverlay";
import styles from "./GlobalPlayerFooter.module.css";

// The in-player overlay is audio-only (podcast episodes + video). The full,
// all-kinds queue lives in the Lectern pane; this panel filters internally and
// never receives a kind-filter prop (D-4).

export default function GlobalPlayerConsumptionPanel({
  onClose,
  returnFocusFallback,
}: {
  onClose: () => void;
  returnFocusFallback?: () => HTMLElement | null;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const playButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const titleId = useId();
  const {
    queueItems,
    currentQueueItemId,
    playQueueItem,
    reorderQueue,
    removeFromQueue,
    clearQueue,
  } = useGlobalPlayer();

  const audioItems = useMemo(() => queueItems.filter(isAudioQueueItem), [queueItems]);

  // The panel reorders only the audio subset, but the reorder endpoint requires the
  // exact full viewer set. Splice the new audio order back into the full queue,
  // leaving readable rows pinned to their absolute slots, and send that.
  const reorderAudioSubset = (nextAudio: typeof audioItems) => {
    const nextAudioIds = nextAudio.map((item) => item.item_id);
    let cursor = 0;
    const fullOrder = queueItems.map((item) =>
      isAudioQueueItem(item) ? nextAudioIds[cursor++] : item.item_id,
    );
    void reorderQueue(fullOrder);
  };

  useDialogOverlay({
    ref: panelRef,
    active: true,
    onDismiss: onClose,
    initialFocus: () => titleRef.current,
    returnFocusFallback,
  });

  const focusQueueTitle = () => {
    titleRef.current?.focus();
  };

  const focusAfterQueueRemoval = (targetItemId: string | null) => {
    window.requestAnimationFrame(() => {
      if (targetItemId) {
        const target = playButtonRefs.current.get(targetItemId);
        if (target) {
          target.focus();
          return;
        }
      }
      focusQueueTitle();
    });
  };

  return (
    <div className={styles.queueOverlay} role="presentation" onClick={onClose}>
      <section
        ref={panelRef}
        className={styles.queuePanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-player-shortcuts-disabled
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.queueHeader}>
          <h2 id={titleId} ref={titleRef} tabIndex={-1} className={styles.queueTitle}>
            Up next
          </h2>
          <Button
            variant="secondary"
            size="sm"
            className={styles.queueCloseButton}
            onClick={onClose}
            aria-label="Close up next"
          >
            Close
          </Button>
        </header>

        {audioItems.length === 0 ? (
          <p className={styles.queueEmpty}>Nothing up next.</p>
        ) : (
          <SortableList
            className={styles.queueList}
            itemClassName={styles.queueListItem}
            items={audioItems}
            getItemId={(item) => item.item_id}
            onReorder={reorderAudioSubset}
            renderItem={({ item, handleProps }) => {
              const isCurrent = item.item_id === currentQueueItemId;
              const itemIndex = audioItems.findIndex(
                (queueItem) => queueItem.item_id === item.item_id,
              );
              const focusTargetItemId =
                audioItems[itemIndex + 1]?.item_id ?? audioItems[itemIndex - 1]?.item_id ?? null;
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
                    ref={(node) => {
                      if (node) {
                        playButtonRefs.current.set(item.item_id, node);
                      } else {
                        playButtonRefs.current.delete(item.item_id);
                      }
                    }}
                    onClick={() => {
                      playQueueItem(item);
                      onClose();
                    }}
                    aria-label={`Play ${item.title} from queue`}
                    aria-current={isCurrent ? "true" : undefined}
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
                      void removeFromQueue(item.item_id).then(() => {
                        focusAfterQueueRemoval(focusTargetItemId);
                      });
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
          <Link href="/lectern" className={styles.queueLecternLink} onClick={onClose}>
            Open Lectern
          </Link>
          <Button
            variant="secondary"
            size="sm"
            className={styles.queueClearButton}
            aria-label="Clear queue"
            disabled={queueItems.length === 0}
            onClick={() => {
              void clearQueue().then(() => {
                window.requestAnimationFrame(focusQueueTitle);
              });
            }}
          >
            Clear queue
          </Button>
        </footer>
      </section>
    </div>
  );
}
