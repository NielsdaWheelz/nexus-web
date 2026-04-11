import { useCallback, useEffect, useRef, useState } from "react";

interface UseMobileChromeVisibilityResult {
  mobileChromeHidden: boolean;
  onContentScroll: (event: React.UIEvent<HTMLDivElement>) => void;
}

export function useMobileChromeVisibility(
  isMobileViewport: boolean,
  enabled: boolean,
): UseMobileChromeVisibilityResult {
  const [mobileChromeHidden, setMobileChromeHidden] = useState(false);
  const lastScrollTopRef = useRef(0);

  useEffect(() => {
    if (!isMobileViewport) {
      setMobileChromeHidden(false);
      lastScrollTopRef.current = 0;
    }
  }, [isMobileViewport]);

  const onContentScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (!isMobileViewport || !enabled) {
        return;
      }
      const scrollTop = event.currentTarget.scrollTop;
      const previous = lastScrollTopRef.current;
      const delta = scrollTop - previous;
      lastScrollTopRef.current = scrollTop;

      if (scrollTop <= 24) {
        setMobileChromeHidden(false);
        return;
      }
      if (delta >= 10) {
        setMobileChromeHidden(true);
        return;
      }
      if (delta <= -10) {
        setMobileChromeHidden(false);
      }
    },
    [enabled, isMobileViewport],
  );

  return { mobileChromeHidden, onContentScroll };
}
