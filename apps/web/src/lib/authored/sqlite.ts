/** The account's sole browser SQL connection. FULL sync reaches the VFS's strict
 * IndexedDB transaction completion before COMMIT acknowledges local writing. */
import * as SQLite from "@journeyapps/wa-sqlite";
import SQLiteFactory from "@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs";
import { IDBBatchAtomicVFS } from "@journeyapps/wa-sqlite/src/examples/IDBBatchAtomicVFS.js";

export type SqlValue = string | number | bigint | Uint8Array | number[] | null;
export interface Database {
  all(sql: string, params?: SqlValue[]): Promise<Record<string, SqlValue>[]>;
  run(sql: string, params?: SqlValue[]): Promise<void>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function openDatabase(accountId: string): Promise<Database> {
  const sqliteModule = await SQLiteFactory({ locateFile: (name: string) => `/_nexus/authored/${name}` });
  const sqlite = SQLite.Factory(sqliteModule);
  // The package's bundled ambient declarations still describe its retired
  // one-argument constructor; the pinned JS exports create(name,module).
  const factory = IDBBatchAtomicVFS as unknown as { create(name: string, module: Parameters<typeof SQLite.Factory>[0]): Promise<Parameters<ReturnType<typeof SQLite.Factory>["vfs_register"]>[0]> };
  const vfs = await factory.create(`nexus-authored-${accountId}`, sqliteModule);
  sqlite.vfs_register(vfs, true);
  const handle = await sqlite.open_v2("authored.sqlite3");
  const all = async (sql: string, params: SqlValue[] = []) => {
    const rows: Record<string, SqlValue>[] = [];
    try {
    for await (const stmt of sqlite.statements(handle, sql)) {
      sqlite.bind_collection(stmt, params);
      const columns = sqlite.column_names(stmt);
      while (await sqlite.step(stmt) === SQLite.SQLITE_ROW) {
        const values = sqlite.row(stmt);
        rows.push(Object.fromEntries(columns.map((name, index) => [name, values[index]])));
      }
    }
    return rows;
    } catch (error) { throw Object.assign(new Error("couldn’t open or save notes on this device", { cause: error }), { code: "E_AUTHORED_LOCAL" }); }
  };
  await all("PRAGMA synchronous=FULL");
  await all("PRAGMA foreign_keys=ON");
  // Missing FTS5 is an unsupported binary, never permission for a memory store.
  await all("CREATE VIRTUAL TABLE temp.authored_fts_probe USING fts5(text)");
  await all("DROP TABLE temp.authored_fts_probe");
  return {
    all,
    run: async (sql, params) => { await all(sql, params); },
    transaction: async operation => {
      await all("BEGIN IMMEDIATE");
      try { const result = await operation(); await all("COMMIT"); return result; }
      catch (error) { await all("ROLLBACK"); throw error; }
    },
    close: async () => { await sqlite.close(handle); await vfs.close(); },
  };
}
