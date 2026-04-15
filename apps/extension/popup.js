const api = globalThis.chrome || globalThis.browser;
const baseUrlInput = document.getElementById("base-url");
const connectButton = document.getElementById("connect");
const captureButton = document.getElementById("capture");
const forgetButton = document.getElementById("forget");
const statusEl = document.getElementById("status");

function setStatus(message) {
  statusEl.textContent = message;
}

function storageGet(keys) {
  return new Promise((resolve) => api.storage.local.get(keys, resolve));
}

function storageSet(value) {
  return new Promise((resolve) => api.storage.local.set(value, resolve));
}

function storageRemove(keys) {
  return new Promise((resolve) => api.storage.local.remove(keys, resolve));
}

function tabsQuery(query) {
  return new Promise((resolve) => api.tabs.query(query, resolve));
}

function executeScript(options) {
  return new Promise((resolve, reject) => {
    api.scripting.executeScript(options, (result) => {
      const error = api.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

function launchWebAuthFlow(details) {
  return new Promise((resolve, reject) => {
    api.identity.launchWebAuthFlow(details, (url) => {
      const error = api.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(url);
    });
  });
}

function requestOriginPermission(url) {
  const parsed = new URL(url);
  const origin =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
      ? `${parsed.protocol}//${parsed.hostname}/*`
      : `${parsed.origin}/*`;

  return new Promise((resolve, reject) => {
    api.permissions.request({ origins: [origin] }, (granted) => {
      const error = api.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(granted);
    });
  });
}

function cleanBaseUrl() {
  return baseUrlInput.value.trim().replace(/\/+$/, "");
}

function filenameFromUrl(url, fallback) {
  const parsed = new URL(url);
  const name = decodeURIComponent(parsed.pathname.split("/").pop() || "").trim();
  return name || fallback;
}

function isWebUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function documentKindFromUrl(url) {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith(".pdf")) {
    return "pdf";
  }
  if (path.endsWith(".epub")) {
    return "epub";
  }
  return null;
}

function documentKindFromContentType(contentType) {
  const normalized = contentType.split(";", 1)[0].trim().toLowerCase();
  if (normalized === "application/pdf") {
    return "pdf";
  }
  if (normalized === "application/epub+zip") {
    return "epub";
  }
  return null;
}

function isDocumentUrl(url) {
  return documentKindFromUrl(url) !== null;
}

function isYouTubeUrl(url) {
  const host = new URL(url).hostname.toLowerCase();
  return host === "youtu.be" || host.endsWith(".youtube.com") || host === "youtube.com";
}

async function connect() {
  const baseUrl = cleanBaseUrl();
  new URL(baseUrl);

  setStatus("Connecting...");
  const redirectUri = api.identity.getRedirectURL();
  const finalUrl = await launchWebAuthFlow({
    url: `${baseUrl}/extension/connect/start?redirect_uri=${encodeURIComponent(redirectUri)}`,
    interactive: true,
  });

  const params = new URLSearchParams(new URL(finalUrl).hash.slice(1));
  const token = params.get("token");
  if (!token) {
    throw new Error(params.get("error") || "Connection failed");
  }

  await requestOriginPermission(baseUrl);
  await storageSet({ baseUrl, extensionToken: token });
  setStatus("Connected.");
}

async function activeTab() {
  const [tab] = await tabsQuery({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("No active tab");
  }
  if (!isWebUrl(tab.url)) {
    throw new Error("Only http and https tabs can be captured");
  }
  return tab;
}

async function postCapture(baseUrl, extensionToken, path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${extensionToken}`,
      ...init.headers,
    },
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message || "Capture failed");
  }
  return body?.data?.media_id || null;
}

async function captureUrl(baseUrl, extensionToken, tab) {
  return postCapture(baseUrl, extensionToken, "/api/media/capture/url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: tab.url }),
  });
}

async function captureFile(baseUrl, extensionToken, tab, fallbackKind) {
  const granted = await requestOriginPermission(tab.url);
  if (!granted) {
    throw new Error("Permission is required to read this file");
  }

  const source = await fetch(tab.url, { credentials: "include" });
  if (!source.ok) {
    throw new Error(`File download failed with status ${source.status}`);
  }

  const responseContentType = source.headers.get("content-type") || "";
  const responseKind = documentKindFromContentType(responseContentType);
  const kind = responseKind || documentKindFromUrl(tab.url) || fallbackKind || "pdf";
  const contentType =
    responseKind !== null
      ? responseContentType
      : kind === "epub"
        ? "application/epub+zip"
        : "application/pdf";

  return postCapture(baseUrl, extensionToken, "/api/media/capture/file", {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "X-Nexus-Filename": filenameFromUrl(tab.url, kind === "epub" ? "capture.epub" : "capture.pdf"),
      "X-Nexus-Source-URL": tab.url,
    },
    body: await source.arrayBuffer(),
  });
}

async function tabLooksLikeDocument(tab) {
  const urlKind = documentKindFromUrl(tab.url);
  if (urlKind !== null) {
    return urlKind;
  }

  const granted = await requestOriginPermission(tab.url);
  if (!granted) {
    return false;
  }

  try {
    const response = await fetch(tab.url, { method: "HEAD", credentials: "include" });
    return documentKindFromContentType(response.headers.get("content-type") || "");
  } catch {
    return null;
  }
}

async function captureArticle(baseUrl, extensionToken, tab) {
  await executeScript({ target: { tabId: tab.id }, files: ["vendor/Readability.js"] });
  await executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  const [capture] = await executeScript({
    target: { tabId: tab.id },
    func: () => globalThis.__nexusCaptureArticle(),
  });

  return postCapture(baseUrl, extensionToken, "/api/media/capture/article", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(capture.result),
  });
}

async function captureCurrentTab() {
  const { baseUrl, extensionToken } = await storageGet(["baseUrl", "extensionToken"]);
  if (!baseUrl || !extensionToken) {
    throw new Error("Connect to Nexus first");
  }

  const tab = await activeTab();
  setStatus("Capturing...");

  let mediaId;
  if (isYouTubeUrl(tab.url)) {
    mediaId = await captureUrl(baseUrl, extensionToken, tab);
  } else if (isDocumentUrl(tab.url)) {
    mediaId = await captureFile(baseUrl, extensionToken, tab);
  } else {
    try {
      mediaId = await captureArticle(baseUrl, extensionToken, tab);
    } catch {
      const documentKind = await tabLooksLikeDocument(tab);
      if (documentKind !== null) {
        mediaId = await captureFile(baseUrl, extensionToken, tab, documentKind);
      } else {
        mediaId = await captureUrl(baseUrl, extensionToken, tab);
      }
    }
  }

  setStatus(mediaId ? `Saved. Open ${baseUrl}/media/${mediaId}` : "Saved.");
}

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  try {
    await connect();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Connection failed");
  } finally {
    connectButton.disabled = false;
  }
});

captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  try {
    await captureCurrentTab();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Capture failed");
  } finally {
    captureButton.disabled = false;
  }
});

forgetButton.addEventListener("click", async () => {
  const { baseUrl, extensionToken } = await storageGet(["baseUrl", "extensionToken"]);
  if (baseUrl && extensionToken) {
    await fetch(`${baseUrl}/api/extension/session`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${extensionToken}` },
    }).catch(() => null);
  }
  await storageRemove(["extensionToken"]);
  setStatus("Token removed.");
});

storageGet(["baseUrl", "extensionToken"]).then(({ baseUrl, extensionToken }) => {
  if (baseUrl) {
    baseUrlInput.value = baseUrl;
  }
  setStatus(extensionToken ? "Connected." : "Not connected.");
});
