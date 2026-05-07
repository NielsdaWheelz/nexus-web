"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import HighlightColorPicker from "@/components/highlights/HighlightColorPicker";
import Button from "@/components/ui/Button";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import styles from "./HighlightActionsMenu.module.css";

export default function HighlightActionsMenu({
  color,
  changingColor,
  deleting,
  isEditingBounds,
  onStartEditBounds,
  onCancelEditBounds,
  onColorChange,
  onDelete,
}: {
  color: HighlightColor;
  changingColor: boolean;
  deleting: boolean;
  isEditingBounds: boolean;
  onStartEditBounds: () => void;
  onCancelEditBounds: () => void;
  onColorChange: (color: HighlightColor) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerId = useId();
  const menuId = useId();

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      setPosition({ top: rect.bottom + 4, left: rect.right });
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      close();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        triggerRef.current?.focus();
      }
    };

    updatePosition();
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [close, open]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") {
      return;
    }

    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const menu =
    open && position ? (
      <div
        ref={menuRef}
        id={menuId}
        className={styles.menu}
        role="menu"
        aria-labelledby={triggerId}
        style={{
          position: "fixed",
          top: `${position.top}px`,
          left: `${position.left}px`,
          transform: "translateX(-100%)",
        }}
        onKeyDown={handleMenuKeyDown}
      >
        <button
          type="button"
          role="menuitem"
          className={styles.menuItem}
          onClick={() => {
            if (isEditingBounds) {
              onCancelEditBounds();
            } else {
              onStartEditBounds();
            }
            close();
          }}
        >
          {isEditingBounds ? "Cancel edit bounds" : "Edit bounds"}
        </button>

        <div className={styles.colorGroup} role="group" aria-label="Highlight color">
          <HighlightColorPicker
            selectedColor={color}
            onSelectColor={(nextColor) => {
              onColorChange(nextColor);
              close();
            }}
            disabled={changingColor}
            disabledColors={[color]}
          />
        </div>

        <button
          type="button"
          role="menuitem"
          className={`${styles.menuItem} ${styles.danger}`}
          disabled={deleting}
          onClick={() => {
            onDelete();
            close();
          }}
        >
          {deleting ? "Deleting..." : "Delete highlight"}
        </button>
      </div>
    ) : null;

  return (
    <>
      <Button
        ref={triggerRef}
        id={triggerId}
        variant="ghost"
        size="sm"
        iconOnly
        aria-label="Actions"
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={15} aria-hidden="true" />
      </Button>
      {menu && typeof document !== "undefined" ? createPortal(menu, document.body) : null}
    </>
  );
}
