import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, readConfig } from "./config.js";
import { getDb, now } from "./db/index.js";
import { pwPaths } from "./maintenance/paths.js";
import { getProject } from "./repo/projects.js";
import { getRun } from "./repo/runs.js";

const GB = 1024 ** 3;

export function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Cases whose latest tested result is still a failure that Dev has not dismissed. */
function openCaseIds(featureId: number | null, projectId: number): Set<number> {
  const rows = getDb()
    .prepare(
      `SELECT r.case_id, r.status, r.dev_status
       FROM results r JOIN runs u ON u.id = r.run_id
       WHERE u.project_id = ? AND u.feature_id IS ? AND r.status != 'pending'
       ORDER BY u.id ASC`,
    )
    .all(projectId, featureId) as Array<{ case_id: number; status: string; dev_status: string }>;
  const latest = new Map<number, { status: string; dev_status: string }>();
  for (const row of rows) latest.set(row.case_id, row);
  const open = new Set<number>();
  for (const [caseId, r] of latest) if (r.status === "fail" && r.dev_status !== "not_bug") open.add(caseId);
  return open;
}

export interface CleanupGroup {
  run_id: number;
  project: string;
  feature_id: number | null;
  feature_title: string | null;
  kind: string;
  started_at: string;
  last_feature_activity: string;
  size_mb: number;
  open_bugs: number;
  suggested: boolean;
  reasons: string[];
}

export function cleanupGroups(): CleanupGroup[] {
  const { staleDays } = readConfig();
  const db = getDb();
  const runs = db
    .prepare(
      `SELECT u.id, u.project_id, u.feature_id, u.kind, u.started_at, p.slug, f.title AS feature_title,
         (SELECT MAX(u2.started_at) FROM runs u2 WHERE u2.project_id = u.project_id AND u2.feature_id IS u.feature_id) AS last_activity
       FROM runs u JOIN projects p ON p.id = u.project_id LEFT JOIN features f ON f.id = u.feature_id
       ORDER BY u.started_at ASC`,
    )
    .all() as Array<{
    id: number;
    project_id: number;
    feature_id: number | null;
    kind: string;
    started_at: string;
    slug: string;
    feature_title: string | null;
    last_activity: string;
  }>;
  const openCache = new Map<string, Set<number>>();
  const staleBefore = Date.now() - staleDays * 24 * 3600 * 1000;
  const groups: CleanupGroup[] = [];
  for (const run of runs) {
    const size = dirSize(join(paths.evidence(), run.slug, String(run.id)));
    if (size === 0) continue;
    const key = `${run.project_id}:${run.feature_id}`;
    if (!openCache.has(key)) openCache.set(key, openCaseIds(run.feature_id, run.project_id));
    const open = openCache.get(key)!;
    const pending = (db.prepare("SELECT COUNT(*) AS n FROM results WHERE run_id = ? AND status = 'pending'").get(run.id) as {
      n: number;
    }).n;
    const reasons: string[] = [];
    const stale = Date.parse(run.last_activity) < staleBefore;
    if (open.size === 0 && pending === 0) reasons.push("Nghiệp vụ không còn bug mở (đã retest Pass hoặc Dev xác nhận không phải bug)");
    if (stale) reasons.push(`Không có lượt test nào trong ${staleDays} ngày`);
    groups.push({
      run_id: run.id,
      project: run.slug,
      feature_id: run.feature_id,
      feature_title: run.feature_title,
      kind: run.kind,
      started_at: run.started_at,
      last_feature_activity: run.last_activity,
      size_mb: round(size / 1024 ** 2),
      open_bugs: open.size,
      // Groups with open bugs are never suggested; the user has to pick them explicitly.
      suggested: open.size === 0 && reasons.length > 0,
      reasons,
    });
  }
  return groups.sort((a, b) => Number(b.suggested) - Number(a.suggested) || b.size_mb - a.size_mb);
}

/** Size in bytes via `du`, much faster than walking big browser profiles in JS. */
function duBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return Number(execFileSync("du", ["-sk", dir], { encoding: "utf8" }).split(/\s+/)[0]) * 1024;
  } catch {
    return dirSize(dir);
  }
}

function npxPlaywrightCopies(): string[] {
  const root = pwPaths.npx();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((dir) => existsSync(join(dir, "node_modules", "@playwright", "mcp")));
}

export function playwrightUsage() {
  const cfg = readConfig();
  const legacyProfiles = pwPaths.legacyProfiles();
  const npx = npxPlaywrightCopies();
  const parts = {
    profile_gb: round(duBytes(pwPaths.profile()) / GB, 3),
    output_gb: round(duBytes(pwPaths.output()) / GB, 3),
    legacy_profiles_gb: round(duBytes(legacyProfiles) / GB, 3),
    npx_copies: npx.length,
    npx_gb: round(npx.reduce((sum, dir) => sum + duBytes(dir), 0) / GB, 3),
  };
  const total = parts.profile_gb + parts.output_gb + parts.legacy_profiles_gb + parts.npx_gb;
  return {
    ...parts,
    total_gb: round(total, 3),
    warn_at_gb: cfg.playwrightWarnGb,
    warn: total >= cfg.playwrightWarnGb,
    cleanup_command: `node "${join(dirname(fileURLToPath(import.meta.url)), "maintenance", "cli.js")}" cleanup`,
  };
}

export function storageCheck(includeGroups = false) {
  const cfg = readConfig();
  const used = dirSize(paths.evidence());
  const warnAt = cfg.storageLimitGb * cfg.warnRatio * GB;
  const warn = used >= warnAt;
  return {
    evidence_dir: paths.evidence(),
    used_gb: round(used / GB, 3),
    limit_gb: cfg.storageLimitGb,
    warn_at_gb: round(warnAt / GB),
    warn,
    groups: warn || includeGroups ? cleanupGroups() : undefined,
    playwright: playwrightUsage(),
  };
}

/** Deletes evidence files of the given runs. Without confirm it only previews what would be removed. */
export function cleanupEvidence(runIds: number[], confirm: boolean) {
  const db = getDb();
  const targets = runIds.map((id) => {
    const run = getRun(id);
    const project = getProject(run.project_id);
    const dir = join(paths.evidence(), project.slug, String(run.id));
    return { run_id: id, dir, bytes: dirSize(dir) };
  });
  const totalBytes = targets.reduce((sum, t) => sum + t.bytes, 0);
  if (!confirm) {
    return {
      dry_run: true,
      runs: targets.map((t) => ({ run_id: t.run_id, size_mb: round(t.bytes / 1024 ** 2) })),
      total_mb: round(totalBytes / 1024 ** 2),
    };
  }
  const ts = now();
  const mark = db.prepare(
    "UPDATE evidence SET cleaned_at = ? WHERE cleaned_at IS NULL AND result_id IN (SELECT id FROM results WHERE run_id = ?)",
  );
  for (const t of targets) {
    rmSync(t.dir, { recursive: true, force: true });
    mark.run(ts, t.run_id);
  }
  return { dry_run: false, freed_mb: round(totalBytes / 1024 ** 2), runs: targets.map((t) => t.run_id) };
}
