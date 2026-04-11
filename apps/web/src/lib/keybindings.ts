const STORAGE_KEY = "nexus.keybindings.v1";

const DEFAULTS: Record<string, string> = {
  "open-palette": "Meta+k",
};

interface ParsedCombo {
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parseKeyCombo(combo: string): ParsedCombo {
  const parts = combo.split("+");
  const key = parts[parts.length - 1].toLowerCase();
  const modifiers = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
  return {
    meta: modifiers.has("meta"),
    ctrl: modifiers.has("ctrl"),
    shift: modifiers.has("shift"),
    alt: modifiers.has("alt"),
    key,
  };
}

export function matchesKeyEvent(combo: string, event: KeyboardEvent): boolean {
  const parsed = parseKeyCombo(combo);

  // "Meta" in a combo accepts either Cmd (Mac) or Ctrl (Windows/Linux)
  const hasCommandModifier = event.metaKey || event.ctrlKey;
  if (parsed.meta && !hasCommandModifier) return false;
  if (!parsed.meta && !parsed.ctrl && hasCommandModifier) return false;
  if (parsed.ctrl && !parsed.meta && !event.ctrlKey) return false;

  if (parsed.shift !== event.shiftKey) return false;
  if (parsed.alt !== event.altKey) return false;
  if (event.key.toLowerCase() !== parsed.key) return false;

  return true;
}

export function loadKeybindings(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        return { ...DEFAULTS, ...parsed };
      }
    }
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

export function saveKeybindings(bindings: Record<string, string>): void {
  // Only persist user overrides (exclude entries identical to defaults)
  const overrides: Record<string, string> = {};
  for (const [id, combo] of Object.entries(bindings)) {
    if (DEFAULTS[id] !== combo) {
      overrides[id] = combo;
    }
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch { /* quota or private mode */ }
}

export function formatKeyCombo(combo: string): string {
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  const symbols = modifiers.map((m) => {
    switch (m.toLowerCase()) {
      case "meta":
        return isMac ? "⌘" : "Ctrl";
      case "ctrl":
        return isMac ? "⌃" : "Ctrl";
      case "shift":
        return isMac ? "⇧" : "Shift";
      case "alt":
        return isMac ? "⌥" : "Alt";
      default:
        return m;
    }
  });

  const displayKey = key.length === 1 ? key.toUpperCase() : key;
  return isMac ? `${symbols.join("")}${displayKey}` : `${symbols.join("+")}+${displayKey}`;
}

export function captureKeyCombo(event: KeyboardEvent): string | null {
  // Require at least one modifier
  if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
    return null;
  }
  // Ignore standalone modifier keys
  if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) {
    return null;
  }
  const parts: string[] = [];
  if (event.metaKey) parts.push("Meta");
  if (event.ctrlKey && !event.metaKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  parts.push(event.key.toLowerCase());
  return parts.join("+");
}

export { DEFAULTS as DEFAULT_KEYBINDINGS };
