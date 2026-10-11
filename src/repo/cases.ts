import { getDb, now, parseJson } from "../db/index.js";
import { NotFoundError, logHistory } from "./projects.js";

export const CASE_TYPES = ["functional", "edge", "negative", "permission", "impact", "ui", "other"] as const;
export const PRIORITIES = ["high", "medium", "low"] as const;
/**
 * pending  → waiting for the user
 * approved → will be tested
 * rejected → user rejected with a reason, waiting for the AI rebuttal
 * rebutted → AI argued back, waiting for the user's final decision
 * dropped  → removed from testing
 */
export const REVIEW_STATUSES = ["pending", "approved", "rejected", "rebutted", "dropped"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface Feature {
  id: number;
  project_id: number;
  title: string;
  requirement: string;
  page_ids: number[];
  created_at: string;
  updated_at: string;
}

export interface TestCase {
  id: number;
  project_id: number;
  feature_id: number;
  code: string;
  page_id: number | null;
  page_name?: string | null;
  title: string;
  type: string;
  priority: string;
  preconditions: string | null;
  steps: string[];
  expected: string;
  test_data: string | null;
  review_status: ReviewStatus;
  reject_reason: string | null;
  ai_rebuttal: string | null;
  created_at: string;
  updated_at: string;
}

export class InvalidStateError extends Error {}

function mapFeature(row: Record<string, unknown>): Feature {
  return { ...(row as unknown as Feature), page_ids: parseJson<number[]>(row.page_ids, []) };
}

function mapCase(row: Record<string, unknown>): TestCase {
  return { ...(row as unknown as TestCase), steps: parseJson<string[]>(row.steps, []) };
}

const CASE_SELECT = `SELECT c.*, p.name AS page_name FROM test_cases c LEFT JOIN pages p ON p.id = c.page_id`;

export function getFeature(featureId: number): Feature {
  const row = getDb().prepare("SELECT * FROM features WHERE id = ?").get(featureId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new NotFoundError(`Feature not found: ${featureId}`);
  return mapFeature(row);
}

export function listFeatures(projectId: number): Array<Feature & { case_count: number; run_count: number }> {
  return (getDb()
    .prepare(
      `SELECT f.*,
         (SELECT COUNT(*) FROM test_cases c WHERE c.feature_id = f.id) AS case_count,
         (SELECT COUNT(*) FROM runs r WHERE r.feature_id = f.id) AS run_count
       FROM features f WHERE f.project_id = ? ORDER BY f.id DESC`,
    )
    .all(projectId) as Array<Record<string, unknown>>).map(
    (row) => ({ ...mapFeature(row), case_count: row.case_count as number, run_count: row.run_count as number }),
  );
}

function assertPagesInProject(projectId: number, pageIds: number[]): void {
  for (const id of pageIds) {
    const row = getDb().prepare("SELECT project_id FROM pages WHERE id = ?").get(id) as
      | { project_id: number }
      | undefined;
    if (!row || row.project_id !== projectId) throw new NotFoundError(`Page ${id} not found in project ${projectId}`);
  }
}

export function createFeature(projectId: number, title: string, requirement: string, pageIds: number[]): Feature {
  assertPagesInProject(projectId, pageIds);
  const ts = now();
  const info = getDb()
    .prepare(
      `INSERT INTO features (project_id, title, requirement, page_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(projectId, title, requirement, JSON.stringify(pageIds), ts, ts);
  const feature = getFeature(Number(info.lastInsertRowid));
  logHistory(projectId, "feature", feature.id, "create", null, feature);
  return feature;
}

export function updateFeature(
  featureId: number,
  patch: { title?: string; requirement?: string; page_ids?: number[] },
): Feature {
  const before = getFeature(featureId);
  if (patch.page_ids) assertPagesInProject(before.project_id, patch.page_ids);
  getDb()
    .prepare("UPDATE features SET title = ?, requirement = ?, page_ids = ?, updated_at = ? WHERE id = ?")
    .run(
      patch.title ?? before.title,
      patch.requirement ?? before.requirement,
      JSON.stringify(patch.page_ids ?? before.page_ids),
      now(),
      featureId,
    );
  const after = getFeature(featureId);
  logHistory(before.project_id, "feature", featureId, "update", before, after);
  return after;
}

export interface CaseInput {
  title: string;
  type: (typeof CASE_TYPES)[number];
  priority?: (typeof PRIORITIES)[number];
  page_id?: number | null;
  preconditions?: string | null;
  steps: string[];
  expected: string;
  test_data?: string | null;
}

function nextCaseNumber(projectId: number): number {
  const rows = getDb().prepare("SELECT code FROM test_cases WHERE project_id = ?").all(projectId) as Array<{
    code: string;
  }>;
  let max = 0;
  for (const { code } of rows) {
    const n = Number(/(\d+)$/.exec(code)?.[1] ?? 0);
    if (n > max) max = n;
  }
  return max + 1;
}

export function createCases(featureId: number, inputs: CaseInput[]): TestCase[] {
  const feature = getFeature(featureId);
  const db = getDb();
  const pageIds = inputs.map((c) => c.page_id).filter((id): id is number => id != null);
  assertPagesInProject(feature.project_id, [...new Set(pageIds)]);
  return db.transaction(() => {
    let n = nextCaseNumber(feature.project_id);
    const ts = now();
    const ids: number[] = [];
    for (const input of inputs) {
      const code = `TC-${String(n++).padStart(3, "0")}`;
      const info = db
        .prepare(
          `INSERT INTO test_cases (project_id, feature_id, code, page_id, title, type, priority, preconditions,
             steps, expected, test_data, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          feature.project_id,
          featureId,
          code,
          input.page_id ?? null,
          input.title,
          input.type,
          input.priority ?? "medium",
          input.preconditions ?? null,
          JSON.stringify(input.steps),
          input.expected,
          input.test_data ?? null,
          ts,
          ts,
        );
      ids.push(Number(info.lastInsertRowid));
    }
    return ids.map(getCase);
  })();
}

export function getCase(caseId: number): TestCase {
  const row = getDb().prepare(`${CASE_SELECT} WHERE c.id = ?`).get(caseId) as Record<string, unknown> | undefined;
  if (!row) throw new NotFoundError(`Test case not found: ${caseId}`);
  return mapCase(row);
}

export function listCases(featureId: number, reviewStatus?: ReviewStatus): TestCase[] {
  const rows = (reviewStatus
    ? getDb().prepare(`${CASE_SELECT} WHERE c.feature_id = ? AND c.review_status = ? ORDER BY c.id`).all(featureId, reviewStatus)
    : getDb().prepare(`${CASE_SELECT} WHERE c.feature_id = ? ORDER BY c.id`).all(featureId)) as Array<
    Record<string, unknown>
  >;
  return rows.map(mapCase);
}

export function updateCase(caseId: number, patch: Partial<CaseInput>): TestCase {
  const before = getCase(caseId);
  if (patch.page_id != null) assertPagesInProject(before.project_id, [patch.page_id]);
  getDb()
    .prepare(
      `UPDATE test_cases SET title = ?, type = ?, priority = ?, page_id = ?, preconditions = ?, steps = ?,
         expected = ?, test_data = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      patch.title ?? before.title,
      patch.type ?? before.type,
      patch.priority ?? before.priority,
      patch.page_id !== undefined ? patch.page_id : before.page_id,
      patch.preconditions !== undefined ? patch.preconditions : before.preconditions,
      JSON.stringify(patch.steps ?? before.steps),
      patch.expected ?? before.expected,
      patch.test_data !== undefined ? patch.test_data : before.test_data,
      now(),
      caseId,
    );
  return getCase(caseId);
}

function setReview(caseId: number, status: ReviewStatus, fields: { reject_reason?: string | null; ai_rebuttal?: string | null }) {
  const before = getCase(caseId);
  getDb()
    .prepare("UPDATE test_cases SET review_status = ?, reject_reason = ?, ai_rebuttal = ?, updated_at = ? WHERE id = ?")
    .run(
      status,
      fields.reject_reason !== undefined ? fields.reject_reason : before.reject_reason,
      fields.ai_rebuttal !== undefined ? fields.ai_rebuttal : before.ai_rebuttal,
      now(),
      caseId,
    );
  return getCase(caseId);
}

export type UserDecision = "approve" | "reject" | "keep" | "accept_drop";

/** Decisions the user made in the test case review file. */
export function applyUserDecision(caseId: number, decision: UserDecision, reason?: string | null): TestCase {
  const current = getCase(caseId);
  const trimmed = reason?.trim() || null;
  switch (decision) {
    case "approve":
      return setReview(caseId, "approved", { reject_reason: null, ai_rebuttal: null });
    case "reject":
      // No reason means nothing to argue against, so the case is dropped right away.
      return trimmed
        ? setReview(caseId, "rejected", { reject_reason: trimmed, ai_rebuttal: null })
        : setReview(caseId, "dropped", { reject_reason: null, ai_rebuttal: null });
    case "keep":
      if (current.review_status !== "rebutted") throw new InvalidStateError(`${current.code} is not waiting for a decision`);
      return setReview(caseId, "approved", {});
    case "accept_drop":
      if (current.review_status !== "rebutted") throw new InvalidStateError(`${current.code} is not waiting for a decision`);
      return setReview(caseId, "dropped", {});
  }
}

/** AI response to a rejection: argue back, or concede and drop the case. */
export function rebutCase(caseId: number, rebuttal: string | null, concede: boolean): TestCase {
  const current = getCase(caseId);
  if (current.review_status !== "rejected") {
    throw new InvalidStateError(`${current.code} is "${current.review_status}", only "rejected" cases can be rebutted`);
  }
  if (concede) return setReview(caseId, "dropped", {});
  if (!rebuttal?.trim()) throw new InvalidStateError("rebuttal is required unless concede is true");
  return setReview(caseId, "rebutted", { ai_rebuttal: rebuttal.trim() });
}

export function reviewSummary(featureId: number) {
  const cases = listCases(featureId);
  const counts = Object.fromEntries(REVIEW_STATUSES.map((s) => [s, 0])) as Record<ReviewStatus, number>;
  for (const c of cases) counts[c.review_status]++;
  return {
    feature_id: featureId,
    total: cases.length,
    counts,
    review_done: counts.pending === 0 && counts.rejected === 0 && counts.rebutted === 0,
    need_rebuttal: cases
      .filter((c) => c.review_status === "rejected")
      .map((c) => ({ id: c.id, code: c.code, title: c.title, reject_reason: c.reject_reason })),
    waiting_user: cases
      .filter((c) => c.review_status === "pending" || c.review_status === "rebutted")
      .map((c) => ({ id: c.id, code: c.code, review_status: c.review_status })),
  };
}
