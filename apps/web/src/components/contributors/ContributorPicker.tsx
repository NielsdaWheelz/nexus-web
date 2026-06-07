"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { useContributorSearch } from "@/lib/contributors/useContributorSearch";
import type { ContributorSummary } from "@/lib/contributors/types";

interface ContributorPickerProps {
  excludeHandle?: string;
  onSelect: (contributor: ContributorSummary) => void;
  busy?: boolean;
}

export default function ContributorPicker({
  excludeHandle,
  onSelect,
  busy = false,
}: ContributorPickerProps) {
  const [query, setQuery] = useState("");
  const suggestions = useContributorSearch(query).filter(
    (contributor) => contributor.handle !== excludeHandle
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <label>
        <span className="sr-only">Search authors</span>
        <Input
          type="search"
          value={query}
          placeholder="Search authors..."
          disabled={busy}
          style={{ width: "min(340px, 100%)" }}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {suggestions.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-1)",
            maxWidth: "360px",
          }}
        >
          {suggestions.map((contributor) => (
            <Button
              key={contributor.handle}
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => onSelect(contributor)}
              style={{ justifyContent: "flex-start" }}
            >
              {contributor.display_name}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
