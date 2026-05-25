"use client";

import { useCallback, useState } from "react";
import { toFeedback, useFeedback } from "@/components/feedback/Feedback";
import { addMediaToLibraries } from "./mediaLibraries";

interface UseAddMediaToLibraries {
  add: (
    mediaId: string,
    libraryIds: string[],
  ) => Promise<{ media_id: string; library_ids_added: string[] }>;
  isAdding: boolean;
}

export function useAddMediaToLibraries(): UseAddMediaToLibraries {
  const feedback = useFeedback();
  const [isAdding, setIsAdding] = useState(false);

  const add = useCallback(
    async (mediaId: string, libraryIds: string[]) => {
      setIsAdding(true);
      try {
        const result = await addMediaToLibraries(mediaId, libraryIds);
        const count = result.library_ids_added.length;
        feedback.show({
          severity: "success",
          title:
            count === 1
              ? "Added to 1 library"
              : `Added to ${count} libraries`,
        });
        return result;
      } catch (err) {
        feedback.show({
          ...toFeedback(err, { fallback: "Failed to update libraries" }),
        });
        throw err;
      } finally {
        setIsAdding(false);
      }
    },
    [feedback],
  );

  return { add, isAdding };
}
