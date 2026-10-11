import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { commandMentions, listProcesses, type Proc } from "./processes.js";
import { pwPaths } from "./paths.js";

export interface CleanupOptions {
  dryRun?: boolean;
  /** Delete old browser builds in ms-playwright, keeping the newest revision of each family. */
  pruneBrowsers?: boolean;
  /** Delete per-workspace profiles of the default Playwright MCP config (loses their logins). */
  purgeLegacyProfiles?: boolean;
  outputMaxDays?: number;
  tmpMaxDays?: number;
  /** Injected in tests. */
  processes?: Proc[];
  now?: number;
}

export interface CleanupItem {
  path: string;
  reason: string;
  bytes: number;
  action: "deleted" | "would_delete" | "skipped_in_use";
}

const PROFILE_CACHE_DIRS = [
  ["Default", "Cache"],
  ["Default", "Code Cache"],
  ["Default", "GPUCache"],
  ["Default", "Service Worker", "CacheStorage"],
  ["Default", "DawnGraphiteCache"],
  ["Default", "DawnWebGPUCache"],
  ["GrShaderCache"],
  ["GraphiteDawnCache"],
  ["GPUPersistentCache"],
  ["ShaderCache"],
  ["component_crx_cache"],
];

const DAY = 24 * 3600 * 1000;

/** Bytes on disk, without following symlinks. */
export function pathSize(target: string): number {
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of readdirSync(target)) total += pathSize(join(target, name));
  return total;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function filesOlderThan(dir: string, cutoff: number): string[] {
  const out: string[] = [];
  for (const entry of listDir(dir)) {
    const stat = lstatSync(entry);
    if (stat.isDirectory()) out.push(...filesOlderThan(entry, cutoff));
    else if (stat.mtimeMs < cutoff) out.push(entry);
  }
  return out;
}

function removeEmptyDirs(dir: string): void {
  for (const entry of listDir(dir)) {
    if (lstatSync(entry).isDirectory()) {
      removeEmptyDirs(entry);
      if (listDir(entry).length === 0) rmSync(entry, { recursive: true, force: true });
    }
  }
}

export function runCleanup(options: CleanupOptions = {}) {
  const procs = options.processes ?? listProcesses();
  const now = options.now ?? Date.now();
  const items: CleanupItem[] = [];
  const inUse = (path: string) => procs.some((p) => commandMentions(p.command, path));

  const remove = (path: string, reason: string, checkInUse = true) => {
    if (!existsSync(path)) return;
    const bytes = pathSize(path);
    if (checkInUse && inUse(path)) {
      items.push({ path, reason, bytes, action: "skipped_in_use" });
      return;
    }
    if (!options.dryRun) rmSync(path, { recursive: true, force: true });
    items.push({ path, reason, bytes, action: options.dryRun ? "would_delete" : "deleted" });
  };

  // 1. Snapshots/screenshots Playwright MCP writes for every action. Evidence worth keeping was copied into qa-mcp.
  const outputDays = options.outputMaxDays ?? 3;
  for (const file of filesOlderThan(pwPaths.output(), now - outputDays * DAY)) {
    remove(file, `Playwright output > ${outputDays} ngày`, false);
  }
  if (!options.dryRun && existsSync(pwPaths.output())) removeEmptyDirs(pwPaths.output());

  // 2. Caches inside the shared profile (cookies/logins stay). Only while the browser is closed.
  const profile = pwPaths.profile();
  if (existsSync(profile)) {
    if (inUse(profile)) {
      items.push({ path: profile, reason: "Profile đang mở", bytes: 0, action: "skipped_in_use" });
    } else {
      for (const parts of PROFILE_CACHE_DIRS) remove(join(profile, ...parts), "Cache trong profile", false);
    }
  }

  // 3. Copies of @playwright/mcp downloaded by `npx @playwright/mcp@latest`.
  for (const dir of listDir(pwPaths.npx())) {
    if (existsSync(join(dir, "node_modules", "@playwright", "mcp"))) remove(dir, "Bản npx @playwright/mcp");
  }

  // 4. Temporary profiles/artifacts Playwright leaves in the temp folder.
  const tmpDays = options.tmpMaxDays ?? 1;
  for (const entry of listDir(pwPaths.tmp())) {
    const name = entry.slice(entry.lastIndexOf(entry.includes("\\") ? "\\" : "/") + 1);
    if (!/^(playwright_chromiumdev_profile-|playwright-artifacts-)/.test(name)) continue;
    if (lstatSync(entry).mtimeMs >= now - tmpDays * DAY) continue;
    remove(entry, `Thư mục tạm Playwright > ${tmpDays} ngày`);
  }

  // 5. Old browser builds: keep the newest revision of each family.
  if (options.pruneBrowsers) {
    const families = new Map<string, Array<{ path: string; rev: number }>>();
    for (const dir of listDir(pwPaths.browsers())) {
      const m = /[\\/]([^\\/]+)-(\d+)$/.exec(dir);
      if (!m) continue;
      if (!families.has(m[1])) families.set(m[1], []);
      families.get(m[1])!.push({ path: dir, rev: Number(m[2]) });
    }
    for (const [family, builds] of families) {
      const newest = Math.max(...builds.map((b) => b.rev));
      for (const b of builds) if (b.rev !== newest) remove(b.path, `Browser cũ (giữ ${family}-${newest})`);
    }
  }

  // 6. Per-workspace profiles of the default Playwright MCP config.
  if (options.purgeLegacyProfiles) {
    for (const dir of listDir(pwPaths.legacyProfiles())) remove(dir, "Profile cũ theo thư mục làm việc");
  }

  const freed = items.filter((i) => i.action !== "skipped_in_use").reduce((sum, i) => sum + i.bytes, 0);
  return { dry_run: !!options.dryRun, freed_mb: Math.round(freed / 1024 / 1024), items };
}
