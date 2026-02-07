/**
 * API Keys management page (BYOK).
 *
 * Security constraints (binding per s3_pr07 §7.3):
 * - Never console.log form state containing the api key.
 * - On submit success or failure, explicitly clear the input state.
 * - Mark input autoComplete="off".
 * - Never store api keys in localStorage.
 * - Key input value exists only in component state during form lifecycle.
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import styles from "./page.module.css";

// ============================================================================
// Types
// ============================================================================

interface ApiKey {
  id: string;
  provider: string;
  key_fingerprint: string;
  status: "untested" | "valid" | "invalid" | "revoked";
  created_at: string;
  last_tested_at: string | null;
}

// ============================================================================
// Component
// ============================================================================

export default function KeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // --------------------------------------------------------------------------
  // Fetch keys
  // --------------------------------------------------------------------------

  const fetchKeys = useCallback(async () => {
    try {
      const response = await apiFetch<{ data: ApiKey[] }>("/api/keys");
      setKeys(response.data);
      setError(null);
    } catch (err) {
      if (isApiError(err)) {
        setError(err.message);
      } else {
        setError("Failed to load keys");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  // --------------------------------------------------------------------------
  // Add/update key
  // --------------------------------------------------------------------------

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setFormError(null);
      setFormSuccess(null);
      setSubmitting(true);

      try {
        await apiFetch("/api/keys", {
          method: "POST",
          body: JSON.stringify({ provider, api_key: apiKey }),
        });
        setFormSuccess(`Key for ${provider} saved.`);
        await fetchKeys();
      } catch (err) {
        if (isApiError(err)) {
          setFormError(err.message);
        } else {
          setFormError("Failed to save key");
        }
      } finally {
        // SECURITY: always clear key input regardless of success/failure
        setApiKey("");
        setSubmitting(false);
      }
    },
    [provider, apiKey, fetchKeys]
  );

  // --------------------------------------------------------------------------
  // Revoke key
  // --------------------------------------------------------------------------

  const handleRevoke = useCallback(
    async (keyId: string) => {
      try {
        await apiFetch(`/api/keys/${keyId}`, { method: "DELETE" });
        await fetchKeys();
      } catch (err) {
        console.error("Failed to revoke key:", err);
      }
    },
    [fetchKeys]
  );

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>API Keys</h1>

      {/* Existing keys */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Your Keys</h2>

        {loading && <div className={styles.loading}>Loading...</div>}
        {error && <div className={styles.error}>{error}</div>}

        {!loading && keys.length === 0 && (
          <div className={styles.emptyKeys}>
            No API keys configured. Add one below.
          </div>
        )}

        <div className={styles.keyList}>
          {keys.map((key) => (
            <div key={key.id} className={styles.keyRow}>
              <div className={styles.keyInfo}>
                <span className={styles.keyProvider}>{key.provider}</span>
                <span className={styles.keyMeta}>
                  <span>...{key.key_fingerprint}</span>
                  <span
                    className={`${styles.keyStatus} ${styles[key.status]}`}
                  >
                    {key.status}
                  </span>
                  {key.last_tested_at && (
                    <span>
                      tested{" "}
                      {new Date(key.last_tested_at).toLocaleDateString()}
                    </span>
                  )}
                </span>
              </div>
              {key.status !== "revoked" && (
                <button
                  className={styles.revokeBtn}
                  onClick={() => handleRevoke(key.id)}
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Add key form */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Add / Update Key</h2>
        <form className={styles.form} onSubmit={handleSubmit}>
          <div className={styles.formRow}>
            <div className={styles.formField}>
              <label className={styles.formLabel} htmlFor="provider">
                Provider
              </label>
              <select
                id="provider"
                className={styles.providerSelect}
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                disabled={submitting}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Gemini</option>
              </select>
            </div>

            <div className={`${styles.formField}`} style={{ flex: 1 }}>
              <label className={styles.formLabel} htmlFor="apiKey">
                API Key
              </label>
              <input
                id="apiKey"
                type="password"
                className={styles.keyInput}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                disabled={submitting}
              />
            </div>

            <button
              type="submit"
              className={styles.submitBtn}
              disabled={submitting || !apiKey.trim()}
            >
              {submitting ? "Saving..." : "Save"}
            </button>
          </div>

          {formError && <div className={styles.formError}>{formError}</div>}
          {formSuccess && (
            <div className={styles.formSuccess}>{formSuccess}</div>
          )}
        </form>
      </div>
    </div>
  );
}
