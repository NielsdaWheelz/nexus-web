export interface VaultFile {
  path: string;
  content: string;
}

export interface VaultConflict {
  path: string;
  message: string;
  content: string;
}

export interface VaultSyncPayload {
  files: VaultFile[];
  delete_paths: string[];
  conflicts: VaultConflict[];
}

const DB_NAME = "nexus-local-vault";
const STORE_NAME = "vault";
const HANDLE_KEY = "directoryHandle";
const AUTO_SYNC_KEY = "nexus.localVault.autoSync";

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandle>;
};

type DirectoryHandleWithPermission = FileSystemDirectoryHandle & {
  queryPermission: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
};

export function isLocalVaultSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export async function pickVaultDirectory(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) {
    throw new Error("Local folder access is not supported in this browser.");
  }
  return picker({ mode: "readwrite" });
}

export async function hasVaultPermission(
  handle: FileSystemDirectoryHandle,
  request: boolean
): Promise<boolean> {
  const permissionHandle = handle as DirectoryHandleWithPermission;
  const options = { mode: "readwrite" as const };
  if ((await permissionHandle.queryPermission(options)) === "granted") {
    return true;
  }
  return request && (await permissionHandle.requestPermission(options)) === "granted";
}

export async function saveVaultDirectoryHandle(
  handle: FileSystemDirectoryHandle
): Promise<void> {
  const db = await openVaultDb();
  await writeIndexedDbValue(db, HANDLE_KEY, handle);
  db.close();
}

export async function loadVaultDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openVaultDb();
  const handle = await readIndexedDbValue<FileSystemDirectoryHandle>(db, HANDLE_KEY);
  db.close();
  return handle;
}

export function getVaultAutoSync(): boolean {
  return localStorage.getItem(AUTO_SYNC_KEY) === "true";
}

export function setVaultAutoSync(enabled: boolean): void {
  localStorage.setItem(AUTO_SYNC_KEY, enabled ? "true" : "false");
}

export async function readEditableVaultFiles(
  handle: FileSystemDirectoryHandle
): Promise<VaultFile[]> {
  const files: VaultFile[] = [];
  for (const directoryName of ["Highlights", "Pages"]) {
    let directory: FileSystemDirectoryHandle;
    try {
      directory = await handle.getDirectoryHandle(directoryName);
    } catch (error) {
      if (isNotFoundError(error)) {
        continue;
      }
      throw error;
    }

    for await (const [name, entry] of directory.entries()) {
      if (entry.kind !== "file" || !name.endsWith(".md") || name.endsWith(".conflict.md")) {
        continue;
      }
      const fileHandle = await directory.getFileHandle(name);
      const file = await fileHandle.getFile();
      files.push({
        path: `${directoryName}/${name}`,
        content: await file.text(),
      });
    }
  }
  return files;
}

export async function writeVaultPayload(
  handle: FileSystemDirectoryHandle,
  payload: VaultSyncPayload
): Promise<void> {
  for (const path of payload.delete_paths) {
    await deleteVaultPath(handle, path);
  }

  await clearDirectory(handle, "Media");
  await clearDirectory(handle, "Sources");

  const returnedHighlightPaths = new Set(
    payload.files
      .map((file) => file.path)
      .filter((path) => path.startsWith("Highlights/"))
  );
  const returnedPagePaths = new Set(
    payload.files
      .map((file) => file.path)
      .filter((path) => path.startsWith("Pages/"))
  );
  await removeStaleHandleFiles(handle, "Highlights", returnedHighlightPaths, /^hl_[0-9a-f]{32}\.md$/);
  await removeStaleHandleFiles(
    handle,
    "Pages",
    returnedPagePaths,
    /--page_[0-9a-f]{32}\.md$/
  );

  for (const file of payload.files) {
    await writeVaultFile(handle, file.path, file.content);
  }
  for (const conflict of payload.conflicts) {
    await writeVaultFile(handle, conflict.path, conflict.content);
  }
}

async function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readIndexedDbValue<T>(
  db: IDBDatabase,
  key: IDBValidKey
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

async function writeIndexedDbValue(
  db: IDBDatabase,
  key: IDBValidKey,
  value: unknown
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function writeVaultFile(
  handle: FileSystemDirectoryHandle,
  path: string,
  content: string
): Promise<void> {
  const parts = path.split("/");
  let directory = handle;
  for (const part of parts.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await directory.getFileHandle(parts[parts.length - 1], { create: true });
  const writer = await fileHandle.createWritable();
  await writer.write(content);
  await writer.close();
}

async function deleteVaultPath(
  handle: FileSystemDirectoryHandle,
  path: string
): Promise<void> {
  const parts = path.split("/");
  let directory = handle;
  for (const part of parts.slice(0, -1)) {
    try {
      directory = await directory.getDirectoryHandle(part);
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }
  }
  try {
    await directory.removeEntry(parts[parts.length - 1], { recursive: true });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

async function clearDirectory(
  handle: FileSystemDirectoryHandle,
  name: string
): Promise<void> {
  try {
    await handle.removeEntry(name, { recursive: true });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
  await handle.getDirectoryHandle(name, { create: true });
}

async function removeStaleHandleFiles(
  handle: FileSystemDirectoryHandle,
  directoryName: "Highlights" | "Pages",
  returnedPaths: Set<string>,
  filenamePattern: RegExp
): Promise<void> {
  let directory: FileSystemDirectoryHandle;
  try {
    directory = await handle.getDirectoryHandle(directoryName, { create: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }

  for await (const [name, entry] of directory.entries()) {
    if (
      entry.kind === "file" &&
      filenamePattern.test(name) &&
      !returnedPaths.has(`${directoryName}/${name}`)
    ) {
      await directory.removeEntry(name);
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}
