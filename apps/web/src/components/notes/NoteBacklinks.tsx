"use client";

import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import { apiFetch } from "@/lib/api/client";
import type { HydratedObjectRef, ObjectRef } from "@/lib/objectRefs";
import styles from "./NoteBacklinks.module.css";

type ObjectLinkRelation =
  | "references"
  | "embeds"
  | "note_about"
  | "used_as_context"
  | "derived_from"
  | "related";

interface ObjectLink {
  id: string;
  relationType: ObjectLinkRelation;
  a: HydratedObjectRef;
  b: HydratedObjectRef;
}

interface ObjectLinksResponse {
  data: {
    links: ObjectLink[];
  };
}

export default function NoteBacklinks({ objectRef }: { objectRef: ObjectRef }) {
  const { objectId, objectType } = objectRef;
  const [links, setLinks] = useState<ObjectLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FeedbackContent | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchObjectLinks({ objectId, objectType })
      .then((items) => {
        if (!cancelled) setLinks(items);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setLinks([]);
          setError(toFeedback(loadError, { fallback: "Backlinks could not be loaded." }));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [objectId, objectType]);

  const backlinks = links.flatMap((link) => {
    const other =
      link.a.objectType === objectType && link.a.objectId === objectId
        ? link.b
        : link.a;
    const href = other.route;
    return href
      ? [{ id: link.id, href, label: other.label, relationType: link.relationType }]
      : [];
  });

  return (
    <section className={styles.backlinks} aria-label="Backlinks">
      <h2 className={styles.title}>Backlinks</h2>
      {loading ? <FeedbackNotice severity="info" title="Loading backlinks..." /> : null}
      {!loading && error ? <FeedbackNotice feedback={error} /> : null}
      {!loading && !error && backlinks.length === 0 ? (
        <FeedbackNotice severity="neutral" title="No linked objects yet." />
      ) : null}
      {backlinks.length > 0 ? (
        <div className={styles.list}>
          {backlinks.map((link) => (
            <a key={link.id} className={styles.linkRow} href={link.href}>
              <Link2 size={14} aria-hidden="true" />
              <span>{link.label}</span>
              <span className={styles.relation}>{link.relationType}</span>
            </a>
          ))}
        </div>
      ) : null}
    </section>
  );
}

async function fetchObjectLinks(object: ObjectRef): Promise<ObjectLink[]> {
  const params = new URLSearchParams({
    object_type: object.objectType,
    object_id: object.objectId,
  });
  const response = await apiFetch<ObjectLinksResponse>(`/api/object-links?${params.toString()}`, {
    cache: "no-store",
  });
  return response.data.links;
}
