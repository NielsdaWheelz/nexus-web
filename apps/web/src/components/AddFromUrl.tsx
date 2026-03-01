"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, isApiError } from "@/lib/api/client";
import styles from "./AddFromUrl.module.css";

type Status = "idle" | "submitting" | "success" | "error";

interface FromUrlResponse {
  data: {
    media_id: string;
    processing_status: string;
  };
}

export default function AddFromUrl() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;

    setStatus("submitting");
    setErrorMsg("");

    try {
      const resp = await apiFetch<FromUrlResponse>("/api/media/from-url", {
        method: "POST",
        body: JSON.stringify({ url: trimmed }),
      });
      setStatus("success");
      setUrl("");
      timerRef.current = setTimeout(() => {
        router.push(`/media/${resp.data.media_id}`);
      }, 800);
    } catch (err) {
      setStatus("error");
      if (isApiError(err)) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg("Failed to add URL. Please try again.");
      }
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.divider}>or</div>
      <form className={styles.form} onSubmit={handleSubmit}>
        <input
          type="text"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (status === "error") setStatus("idle");
          }}
          placeholder="Paste a URL..."
          className={styles.input}
          disabled={status === "submitting"}
        />
        <button
          type="submit"
          className={styles.submitBtn}
          disabled={status === "submitting" || !url.trim()}
        >
          {status === "submitting" ? "Adding..." : "Add"}
        </button>
      </form>
      {status === "success" && (
        <div className={`${styles.status} ${styles.success}`}>
          URL added — processing...
        </div>
      )}
      {status === "error" && (
        <div className={`${styles.status} ${styles.error}`}>
          {errorMsg}
        </div>
      )}
    </div>
  );
}
