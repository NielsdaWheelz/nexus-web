/**
 * Nexus Post Room — Cloudflare Email Worker.
 *
 * Receives raw MIME messages via Cloudflare Email Routing, enforces a 2 MB
 * size cap (bounces larger messages), HMAC-SHA256-signs the raw body, and
 * POSTs to the Nexus /ingest/email endpoint.
 *
 * Required Worker secrets (set via `wrangler secret put`):
 *   EMAIL_INGEST_HMAC_SECRET  — shared HMAC secret (must match backend config)
 *   EMAIL_INGEST_API_URL      — full URL of the /ingest/email endpoint
 *                               e.g. "https://api.example.com/ingest/email"
 */

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB — must match EMAIL_INGEST_MAX_BYTES

export default {
  /**
   * @param {ForwardableEmailMessage} message
   * @param {Env} env
   * @param {ExecutionContext} ctx
   */
  async email(message, env, ctx) {
    const rawStream = message.raw;
    const reader = rawStream.getReader();
    const chunks = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BYTES) {
        // Bounce with a permanent failure so the sender is notified.
        message.setReject("Message exceeds the 2 MB size limit for Nexus Post Room.");
        return;
      }
      chunks.push(value);
    }

    // Assemble raw bytes.
    const rawBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      rawBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // HMAC-SHA256(raw body, secret).
    const secret = env.EMAIL_INGEST_HMAC_SECRET;
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signatureBuffer = await crypto.subtle.sign("HMAC", keyMaterial, rawBytes);
    const signature = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const recipient = message.to;
    const apiUrl = env.EMAIL_INGEST_API_URL;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "message/rfc822",
        "X-Nexus-Email-Signature": signature,
        "X-Nexus-Email-Recipient": recipient,
      },
      body: rawBytes,
    });

    if (!response.ok) {
      // Log and bounce so the sender learns it failed.
      const body = await response.text().catch(() => "(no body)");
      console.error(
        `Post Room ingest failed: status=${response.status} body=${body}`,
      );
      message.setReject(`Nexus Post Room rejected the message (HTTP ${response.status}).`);
    }
    // 200 / 2xx: silently accept (the message was ingested or was a duplicate).
  },
};
