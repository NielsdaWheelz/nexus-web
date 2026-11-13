/** Email import's SMTP adapter. Only declared permanent refusals call setReject.
 * Throwing preserves failure eligibility; actual transport deferral requires live qualification.
 * Secrets: EMAIL_INGEST_HMAC_SECRET and EMAIL_INGEST_API_URL.
 */
import { WIRE_REVISION } from "../../../apps/web/src/lib/api/wire.gen.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
  async email(message, env) {
    const recipient = message.to.trim().toLowerCase();
    const parts = recipient.split("@");
    if (
      /[^\x21-\x7e]/.test(recipient) ||
      parts.length !== 2 ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(parts[0]) ||
      parts[1].length > 253 ||
      recipient.length > 254 ||
      parts[1].split(".").length < 2 ||
      !parts[1].split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ) {
      throw new Error("email import recipient is invalid");
    }
    if (!env.EMAIL_INGEST_HMAC_SECRET?.trim()) {
      throw new Error("email import secret is not configured");
    }

    const reader = message.raw.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BYTES) {
        await reader.cancel();
        message.setReject("email exceeds the 2 mib limit.");
        return;
      }
      chunks.push(value);
    }
    const rawBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      rawBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const encoder = new TextEncoder();
    const prefix = encoder.encode(`nexus-email\n${WIRE_REVISION}\n${recipient}\n`);
    const signedBytes = new Uint8Array(prefix.length + rawBytes.length);
    signedBytes.set(prefix);
    signedBytes.set(rawBytes, prefix.length);
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(env.EMAIL_INGEST_HMAC_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, signedBytes)))
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const response = await fetch(env.EMAIL_INGEST_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "message/rfc822",
        "X-Nexus-Wire": String(WIRE_REVISION),
        "X-Nexus-Email-Signature": signature,
        "X-Nexus-Email-Recipient": recipient,
      },
      body: rawBytes,
    });
    const requestId = response.headers.get("x-request-id") ?? "";
    const safeId = requestId.match(/^[A-Za-z0-9._:-]{1,128}/)?.[0] === requestId ? requestId : "unknown";
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`email import returned unreadable json: status=${response.status} code=unknown request_id=${safeId}`);
    }
    const data = body?.data;
    if (
      response.status === 200 &&
      body !== null && typeof body === "object" && Object.keys(body).length === 1 &&
      data !== null && typeof data === "object" && Object.keys(data).length === 2 &&
      ((data.outcome === "suppressed" && data.media_id === null) ||
        ((data.outcome === "accepted" || data.outcome === "duplicate") &&
          typeof data.media_id === "string" && data.media_id.length === 36 && UUID.test(data.media_id)))
    ) {
      return;
    }
    const code = body?.error?.code;
    if (response.status === 400 && code === "E_INVALID_REQUEST") {
      message.setReject("couldn’t read this email.");
      return;
    }
    if (response.status === 413 && code === "E_SOURCE_TOO_LARGE") {
      message.setReject("email exceeds the 2 mib limit.");
      return;
    }
    const safeCode = typeof code === "string" && code.match(/^E_[A-Z0-9_]{1,64}/)?.[0] === code ? code : "unknown";
    throw new Error(`email import failed: status=${response.status} code=${safeCode} request_id=${safeId}`);
  },
};
