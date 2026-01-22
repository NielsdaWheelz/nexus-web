"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import styles from "./FileUpload.module.css";

type UploadStatus =
  | "idle"
  | "validating"
  | "initializing"
  | "uploading"
  | "confirming"
  | "success"
  | "error";

interface UploadInitResponse {
  data: {
    media_id: string;
    storage_path: string;
    token: string;
    expires_at: string;
  };
}

interface IngestResponse {
  data: {
    media_id: string;
    duplicate: boolean;
  };
}

const ACCEPTED_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "application/epub+zip": "epub",
};

const MAX_SIZES: Record<string, number> = {
  pdf: 100 * 1024 * 1024, // 100 MB
  epub: 50 * 1024 * 1024, // 50 MB
};

export default function FileUpload() {
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const validateFile = useCallback((file: File): string | null => {
    const kind = ACCEPTED_TYPES[file.type];
    if (!kind) {
      return "Invalid file type. Only PDF and EPUB files are supported.";
    }

    const maxSize = MAX_SIZES[kind];
    if (file.size > maxSize) {
      const maxMB = Math.round(maxSize / 1024 / 1024);
      return `File too large. Maximum size for ${kind.toUpperCase()} is ${maxMB} MB.`;
    }

    return null;
  }, []);

  const uploadFile = useCallback(
    async (file: File) => {
      setError(null);
      setProgress(0);

      // Validate
      setStatus("validating");
      const validationError = validateFile(file);
      if (validationError) {
        setError(validationError);
        setStatus("error");
        return;
      }

      const kind = ACCEPTED_TYPES[file.type];

      try {
        // Initialize upload
        setStatus("initializing");
        const initResponse = await fetch("/api/media/upload/init", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            kind,
            filename: file.name,
            content_type: file.type,
            size_bytes: file.size,
          }),
        });

        if (!initResponse.ok) {
          const errData = await initResponse.json().catch(() => ({}));
          throw new Error(
            errData?.error?.message || `Failed to initialize upload (${initResponse.status})`
          );
        }

        const initData: UploadInitResponse = await initResponse.json();
        const { media_id, storage_path, token } = initData.data;

        // Upload to Supabase Storage using signed URL
        setStatus("uploading");
        const supabase = createClient();

        // Use uploadToSignedUrl which is the official method for signed uploads
        const { error: uploadError } = await supabase.storage
          .from("media")
          .uploadToSignedUrl(storage_path, token, file, {
            upsert: false,
          });

        if (uploadError) {
          throw new Error(`Upload failed: ${uploadError.message}`);
        }

        setProgress(100);

        // Confirm ingest
        setStatus("confirming");
        const ingestResponse = await fetch(`/api/media/${media_id}/ingest`, {
          method: "POST",
        });

        if (!ingestResponse.ok) {
          const errData = await ingestResponse.json().catch(() => ({}));
          throw new Error(
            errData?.error?.message || `Failed to confirm upload (${ingestResponse.status})`
          );
        }

        const ingestData: IngestResponse = await ingestResponse.json();
        const finalMediaId = ingestData.data.media_id;
        const isDuplicate = ingestData.data.duplicate;

        setStatus("success");

        // Navigate to media page after short delay
        setTimeout(() => {
          if (isDuplicate) {
            router.push(`/media/${finalMediaId}?duplicate=true`);
          } else {
            router.push(`/media/${finalMediaId}`);
          }
        }, 1000);
      } catch (err) {
        console.error("Upload error:", err);
        setError(err instanceof Error ? err.message : "Upload failed");
        setStatus("error");
      }
    },
    [validateFile, router]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        uploadFile(file);
      }
      // Reset input so same file can be selected again
      e.target.value = "";
    },
    [uploadFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);

      const file = e.dataTransfer.files?.[0];
      if (file) {
        uploadFile(file);
      }
    },
    [uploadFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleClick = useCallback(() => {
    if (status === "idle" || status === "error") {
      fileInputRef.current?.click();
    }
  }, [status]);

  const handleRetry = useCallback(() => {
    setStatus("idle");
    setError(null);
    setProgress(0);
  }, []);

  const isUploading = ["validating", "initializing", "uploading", "confirming"].includes(status);

  return (
    <div className={styles.container}>
      <div
        className={`${styles.dropzone} ${dragOver ? styles.dragOver : ""} ${
          isUploading ? styles.uploading : ""
        } ${status === "error" ? styles.error : ""} ${status === "success" ? styles.success : ""}`}
        onClick={handleClick}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        role="button"
        tabIndex={0}
        aria-label="Upload file"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.epub,application/pdf,application/epub+zip"
          onChange={handleFileSelect}
          className={styles.input}
          disabled={isUploading}
        />

        {status === "idle" && (
          <>
            <div className={styles.icon}>📄</div>
            <div className={styles.text}>
              <span className={styles.primary}>Drop a file here or click to upload</span>
              <span className={styles.secondary}>PDF (up to 100 MB) or EPUB (up to 50 MB)</span>
            </div>
          </>
        )}

        {isUploading && (
          <>
            <div className={styles.spinner} />
            <div className={styles.text}>
              <span className={styles.primary}>
                {status === "validating" && "Validating..."}
                {status === "initializing" && "Initializing upload..."}
                {status === "uploading" && "Uploading..."}
                {status === "confirming" && "Processing..."}
              </span>
              {status === "uploading" && (
                <span className={styles.secondary}>{progress}% complete</span>
              )}
            </div>
          </>
        )}

        {status === "success" && (
          <>
            <div className={styles.successIcon}>✓</div>
            <div className={styles.text}>
              <span className={styles.primary}>Upload complete!</span>
              <span className={styles.secondary}>Redirecting...</span>
            </div>
          </>
        )}

        {status === "error" && (
          <>
            <div className={styles.errorIcon}>✗</div>
            <div className={styles.text}>
              <span className={styles.primary}>{error || "Upload failed"}</span>
              <button className={styles.retryButton} onClick={handleRetry}>
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
