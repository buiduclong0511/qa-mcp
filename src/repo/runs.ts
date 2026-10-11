import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { paths } from "../config.js";
import { pwPaths } from "../maintenance/paths.js";
import { getDb, now, parseJson } from "../db/index.js";
import { getCase, getFeature, InvalidStateError } from "./cases.js";
import { getProject, NotFoundError } from "./projects.js";

export const RESULT_STATUSES = ["pending", "pass", "fail", "blocked", "skipped"] as const;
export const DEV_STATUSES = ["none", "fixed", "not_bug"] as const;
export const EVIDENCE_KINDS = ["screenshot", "console", "network", "other"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];
export type DevStatus = (typeof DEV_STATUSES)[number];

export interface Run {
  id: number;
  project_id: number;
  feature_id: number | null;
  kind: "initial" | "retest";
  parent_run_id: number | null;
  environment: string | null;
  source_excel: string | null;
  note: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface Evidence {
  id: number;
  result_id: number;
  kind: string;
  path: string;
  step_no: number | null;
  caption: string | null;
  sha256: string | null;
  size: number;
  cleaned_at: string | null;
  created_at: string;
}

export interface ResultRow {
  id: number;
  run_id: number;
  case_id: number;
  status: ResultStatus;
  actual: string | null;
  console_errors: string | null;
  bug_ref: string | null;
  dev_status: DevStatus;
  dev_note: string | null;
  tested_at: string | null;
}

export interface ResultDetail extends ResultRow {
  code: string;
  title: string;
  type: string;
  priority: string;
  page_name: string | null;
  preconditions: string | null;
  steps: string[];
  expected: string;
  test_data: string | null;
  evidence: Evidence[];
}

export function getRun(runId: number): Run {
  const row = getDb().prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Run | undefined;
  if (!row) throw new NotFoundError(`Run not found: ${runId}`);
  return row;
}

export function listRuns(projectId: number, featureId?: number): Array<Run & { total: number; failed: number }> {
  const where = featureId != null ? "r.project_id = ? AND r.feature_id = ?" : "r.project_id = ?";
  const args = featureId != null ? [projectId, featureId] : [projectId];
  return getDb()
    .prepare(
      `SELECT r.*,
         (SELECT COUNT(*) FROM results x WHERE x.run_id = r.id) AS total,
         (SELECT COUNT(*) FROM results x WHERE x.run_id = r.id AND x.status = 'fail') AS failed
       FROM runs r WHERE ${where} ORDER BY r.id DESC`,
    )
    .all(...args) as Array<Run & { total: number; failed: number }>;
}

export interface CreateRunInput {
  project: string | number;
  kind: "initial" | "retest";
  feature_id?: number;
  parent_run_id?: number;
  /** Optional subset; defaults to approved cases (initial) or Dev-fixed cases (retest). */
  case_ids?: number[];
  environment?: string | null;
  source_excel?: string | null;
  note?: string | null;
}

export function createRun(input: CreateRunInput): { run: Run; case_ids: number[] } {
  const project = getProject(input.project);
  const db = getDb();
  let featureId: number | null = null;
  let caseIds: number[];

  if (input.kind === "initial") {
    if (input.feature_id == null) throw new InvalidStateError("feature_id is required for an initial run");
    const feature = getFeature(input.feature_id);
    if (feature.project_id !== project.id) throw new NotFoundError(`Feature ${feature.id} not in project ${project.slug}`);
    featureId = feature.id;
    const approved = (db
      .prepare("SELECT id FROM test_cases WHERE feature_id = ? AND review_status = 'approved' ORDER BY id")
      .all(feature.id) as Array<{ id: number }>).map((r) => r.id);
    if (input.case_ids) {
      const notApproved = input.case_ids.filter((id) => !approved.includes(id));
      if (notApproved.length) throw new InvalidStateError(`Cases not approved for this feature: ${notApproved.join(", ")}`);
      caseIds = input.case_ids;
    } else {
      caseIds = approved;
    }
  } else {
    if (input.parent_run_id == null) throw new InvalidStateError("parent_run_id is required for a retest run");
    const parent = getRun(input.parent_run_id);
    if (parent.project_id !== project.id) throw new NotFoundError(`Run ${parent.id} not in project ${project.slug}`);
    featureId = parent.feature_id;
    const parentCases = db.prepare("SELECT case_id, dev_status FROM results WHERE run_id = ?").all(parent.id) as Array<{
      case_id: number;
      dev_status: DevStatus;
    }>;
    if (input.case_ids) {
      const known = new Set(parentCases.map((r) => r.case_id));
      const unknown = input.case_ids.filter((id) => !known.has(id));
      if (unknown.length) throw new InvalidStateError(`Cases not in run ${parent.id}: ${unknown.join(", ")}`);
      caseIds = input.case_ids;
    } else {
      caseIds = parentCases.filter((r) => r.dev_status === "fixed").map((r) => r.case_id);
    }
  }
  if (caseIds.length === 0) {
    throw new InvalidStateError(
      input.kind === "initial" ? "No approved test cases to run" : "No cases marked as fixed by Dev in the parent run",
    );
  }

  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO runs (project_id, feature_id, kind, parent_run_id, environment, source_excel, note, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        featureId,
        input.kind,
        input.parent_run_id ?? null,
        input.environment ?? project.environment,
        input.source_excel ?? null,
        input.note ?? null,
        now(),
      );
    const runId = Number(info.lastInsertRowid);
    const insert = db.prepare("INSERT INTO results (run_id, case_id) VALUES (?, ?)");
    for (const id of caseIds) insert.run(runId, id);
    return { run: getRun(runId), case_ids: caseIds };
  })();
}

function getResultByRunCase(runId: number, caseId: number): ResultRow {
  const row = getDb().prepare("SELECT * FROM results WHERE run_id = ? AND case_id = ?").get(runId, caseId) as
    | ResultRow
    | undefined;
  if (!row) throw new NotFoundError(`Case ${caseId} is not part of run ${runId}`);
  return row;
}

export function getResult(resultId: number): ResultRow {
  const row = getDb().prepare("SELECT * FROM results WHERE id = ?").get(resultId) as ResultRow | undefined;
  if (!row) throw new NotFoundError(`Result not found: ${resultId}`);
  return row;
}

export function recordResult(
  runId: number,
  caseId: number,
  input: { status: ResultStatus; actual?: string | null; console_errors?: string | null; bug_ref?: string | null },
): ResultRow {
  const current = getResultByRunCase(runId, caseId);
  // Recording again replaces the previous outcome: a re-run Pass must not keep the old failure text or bug id.
  getDb()
    .prepare("UPDATE results SET status = ?, actual = ?, console_errors = ?, bug_ref = ?, tested_at = ? WHERE id = ?")
    .run(input.status, input.actual ?? null, input.console_errors ?? null, input.bug_ref ?? null, now(), current.id);
  return getResult(current.id);
}

export function setDevStatus(resultId: number, devStatus: DevStatus, devNote?: string | null): ResultRow {
  const current = getResult(resultId);
  getDb()
    .prepare("UPDATE results SET dev_status = ?, dev_note = ? WHERE id = ?")
    .run(devStatus, devNote !== undefined ? devNote : current.dev_note, resultId);
  return getResult(resultId);
}

export function finishRun(runId: number): Run {
  getRun(runId);
  getDb().prepare("UPDATE runs SET finished_at = ? WHERE id = ?").run(now(), runId);
  return getRun(runId);
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function evidenceAbsPath(relPath: string): string {
  const root = paths.evidence();
  const abs = resolve(root, relPath);
  if (relative(root, abs).startsWith("..")) throw new InvalidStateError("Evidence path escapes the evidence folder");
  return abs;
}

/**
 * Playwright MCP reports screenshots relative to its own working directory, which may differ
 * from ours; fall back to the shared Playwright output folder by file name.
 */
function resolveSourcePath(sourcePath: string): string {
  const candidates = isAbsolute(sourcePath)
    ? [sourcePath]
    : [resolve(process.cwd(), sourcePath), join(pwPaths.output(), basename(sourcePath))];
  const found = candidates.find((file) => existsSync(file));
  if (!found) throw new NotFoundError(`File not found: ${candidates.join(" or ")}`);
  return found;
}

export interface AttachInput {
  kind: (typeof EVIDENCE_KINDS)[number];
  /** Existing file to copy (e.g. a Playwright screenshot). */
  source_path?: string;
  /** Text content to store as a file (console/network logs). */
  content?: string;
  step_no?: number | null;
  caption?: string | null;
}

export function attachEvidence(runId: number, caseId: number, input: AttachInput): Evidence {
  const run = getRun(runId);
  const project = getProject(run.project_id);
  const result = getResultByRunCase(runId, caseId);
  const testCase = getCase(caseId);
  if (!input.source_path && input.content == null) throw new InvalidStateError("Provide source_path or content");

  let ext: string;
  if (input.source_path) {
    const source = resolveSourcePath(input.source_path);
    ext = extname(source) || ".bin";
    input = { ...input, source_path: source };
  } else {
    ext = ".txt";
  }

  const relDir = join(project.slug, String(run.id), testCase.code);
  const absDir = join(paths.evidence(), relDir);
  mkdirSync(absDir, { recursive: true });
  const seq = String(readdirSync(absDir).length + 1).padStart(2, "0");
  const stepPart = input.step_no != null ? `-step${input.step_no}` : "";
  const fileName = `${seq}${stepPart}-${input.kind}${ext.toLowerCase()}`;
  const absFile = join(absDir, fileName);
  if (input.source_path) copyFileSync(input.source_path, absFile);
  else writeFileSync(absFile, input.content ?? "");

  const info = getDb()
    .prepare(
      `INSERT INTO evidence (result_id, kind, path, step_no, caption, sha256, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      result.id,
      input.kind,
      join(relDir, fileName),
      input.step_no ?? null,
      input.caption ?? null,
      sha256(absFile),
      statSync(absFile).size,
      now(),
    );
  return getDb().prepare("SELECT * FROM evidence WHERE id = ?").get(Number(info.lastInsertRowid)) as Evidence;
}

export function runResults(runId: number): ResultDetail[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.*, c.code, c.title, c.type, c.priority, c.preconditions, c.steps, c.expected, c.test_data,
         p.name AS page_name
       FROM results r
       JOIN test_cases c ON c.id = r.case_id
       LEFT JOIN pages p ON p.id = c.page_id
       WHERE r.run_id = ? ORDER BY c.id`,
    )
    .all(runId) as Array<Record<string, unknown>>;
  const evidenceStmt = db.prepare("SELECT * FROM evidence WHERE result_id = ? ORDER BY id");
  return rows.map((row) => ({
    ...(row as unknown as ResultDetail),
    steps: parseJson<string[]>(row.steps, []),
    evidence: evidenceStmt.all(row.id) as Evidence[],
  }));
}

export function runSummary(runId: number) {
  const run = getRun(runId);
  const project = getProject(run.project_id);
  const feature = run.feature_id != null ? getFeature(run.feature_id) : null;
  const results = runResults(runId);
  const counts = Object.fromEntries(RESULT_STATUSES.map((s) => [s, 0])) as Record<ResultStatus, number>;
  const dev = Object.fromEntries(DEV_STATUSES.map((s) => [s, 0])) as Record<DevStatus, number>;
  for (const r of results) {
    counts[r.status]++;
    if (r.status === "fail") dev[r.dev_status]++;
  }
  return {
    run,
    project: { id: project.id, slug: project.slug, name: project.name },
    feature: feature ? { id: feature.id, title: feature.title } : null,
    total: results.length,
    counts,
    open_bugs: results.filter((r) => r.status === "fail" && r.dev_status === "none").length,
    fail_dev_status: dev,
    failed_cases: results
      .filter((r) => r.status === "fail")
      .map((r) => ({ case_id: r.case_id, code: r.code, title: r.title, bug_ref: r.bug_ref, dev_status: r.dev_status })),
  };
}
