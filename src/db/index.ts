import Database from "better-sqlite3";
import { ensureDirs, paths } from "../config.js";
import { migrate } from "./schema.js";

let db: Database.Database | null = null;
let openedPath: string | null = null;

export function getDb(): Database.Database {
  const file = paths.db();
  if (db && openedPath === file) return db;
  ensureDirs();
  db?.close();
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  openedPath = file;
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
  openedPath = null;
}

export function now(): string {
  return new Date().toISOString();
}

/** Parse JSON columns safely; bad data falls back instead of throwing. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
