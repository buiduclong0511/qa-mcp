import ExcelJS from "exceljs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../db/index.js";
import {
  applyUserDecision,
  getCase,
  getFeature,
  InvalidStateError,
  listCases,
  reviewSummary,
  type ReviewStatus,
  type TestCase,
} from "../repo/cases.js";
import { getProject } from "../repo/projects.js";
import { cellText, firstId, headerIndex as readHeader, normalizeUserPath, readMeta } from "./common.js";
import { downloadsDir, styleHeader, timestamp } from "./export.js";
import {
  CASE_COL,
  CASES_META_SCHEMA,
  CASES_SHEET,
  DECISION_APPROVE,
  DECISION_REJECT,
  META_SHEET,
  META_VERSION,
  PRIORITY_LABELS,
  REVIEW_LABELS,
  TYPE_LABELS,
} from "./labels.js";

const NEEDS_DECISION_FILL = "FFFEF3C7";

function prefilledDecision(c: TestCase): string {
  if (c.review_status === "approved") return DECISION_APPROVE;
  if (c.review_status === "rejected" || c.review_status === "dropped") return DECISION_REJECT;
  return ""; // pending, or rebutted: the user has to choose (again)
}

/** Test case review file: the user fills "Đánh giá" (Duyệt / Không duyệt) and "Lý do", then sends it back. */
export async function exportCases(featureId: number): Promise<{ xlsx: string; cases: number }> {
  const feature = getFeature(featureId);
  const project = getProject(feature.project_id);
  const cases = listCases(featureId);

  const wb = new ExcelJS.Workbook();
  wb.creator = "qa-mcp";
  wb.created = new Date();
  const ws = wb.addWorksheet(CASES_SHEET, { views: [{ state: "frozen", ySplit: 1 }] });
  const columns: Array<{ key: keyof typeof CASE_COL; width: number; hidden?: boolean }> = [
    { key: "code", width: 10 },
    { key: "page", width: 18 },
    { key: "type", width: 16 },
    { key: "priority", width: 11 },
    { key: "title", width: 36 },
    { key: "preconditions", width: 26 },
    { key: "steps", width: 44 },
    { key: "testData", width: 22 },
    { key: "expected", width: 36 },
    { key: "current", width: 22 },
    { key: "decision", width: 14 },
    { key: "reason", width: 32 },
    { key: "rebuttal", width: 40 },
    { key: "caseId", width: 8, hidden: true },
  ];
  ws.columns = columns.map((c) => ({ header: CASE_COL[c.key], key: c.key, width: c.width, hidden: c.hidden }));
  styleHeader(ws);

  for (const c of cases) {
    const row = ws.addRow({
      code: c.code,
      page: c.page_name ?? "",
      type: TYPE_LABELS[c.type] ?? c.type,
      priority: PRIORITY_LABELS[c.priority] ?? c.priority,
      title: c.title,
      preconditions: c.preconditions ?? "",
      steps: c.steps.map((step, i) => `${i + 1}. ${step}`).join("\n"),
      testData: c.test_data ?? "",
      expected: c.expected,
      current: REVIEW_LABELS[c.review_status],
      decision: prefilledDecision(c),
      reason: c.reject_reason ?? "",
      rebuttal: c.ai_rebuttal ?? "",
      caseId: c.id,
    });
    row.alignment = { vertical: "top", wrapText: true };
    row.getCell("decision").dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [`"${DECISION_APPROVE},${DECISION_REJECT}"`],
      showErrorMessage: true,
      errorTitle: "Giá trị không hợp lệ",
      error: `Chọn ${DECISION_APPROVE} hoặc ${DECISION_REJECT}`,
    };
    if (c.review_status === "pending" || c.review_status === "rebutted") {
      row.getCell("decision").fill = { type: "pattern", pattern: "solid", fgColor: { argb: NEEDS_DECISION_FILL } };
    }
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length - 1 } };

  const meta = wb.addWorksheet(META_SHEET, { state: "veryHidden" });
  meta.addRows([
    ["schema", CASES_META_SCHEMA],
    ["version", META_VERSION],
    ["project_id", project.id],
    ["project_slug", project.slug],
    ["feature_id", feature.id],
    ["exported_at", new Date().toISOString()],
  ]);

  mkdirSync(downloadsDir(), { recursive: true });
  const xlsx = join(downloadsDir(), `${project.slug}-feature${feature.id}-testcase-${timestamp()}.xlsx`);
  await wb.xlsx.writeFile(xlsx);
  return { xlsx, cases: cases.length };
}

type Change = { case_id: number; code: string; from: ReviewStatus; action: "approve" | "reject" | "keep" | "accept_drop"; reason: string | null };

/**
 * Read the review file back. Per row (blank "Đánh giá" = no change):
 * Duyệt → approved (after an AI rebuttal: keep the case);
 * Không duyệt → rejected with the reason (no reason: dropped; after an AI rebuttal: drop it).
 */
export async function importCases(file: string, options: { dry_run?: boolean; allow_partial?: boolean } = {}) {
  file = normalizeUserPath(file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const ws = wb.getWorksheet(CASES_SHEET);
  const metaMap = readMeta(wb);
  if (metaMap?.get("schema") === "qa-mcp-result" || (!ws && wb.getWorksheet("Kết quả"))) {
    throw new InvalidStateError("Đây là file kết quả test, dùng excel_import");
  }
  if (!ws) throw new InvalidStateError(`Không phải file test case của qa-mcp: thiếu sheet "${CASES_SHEET}"`);
  const headerIndex = readHeader(ws);
  for (const required of [CASE_COL.caseId, CASE_COL.decision, CASE_COL.reason]) {
    if (!headerIndex.has(required)) throw new InvalidStateError(`Thiếu cột "${required}"`);
  }

  let feature;
  if (metaMap) {
    if (metaMap.get("schema") !== CASES_META_SCHEMA) throw new InvalidStateError("Không phải file test case của qa-mcp");
    const project = getProject(Number(metaMap.get("project_id")));
    if (project.slug !== metaMap.get("project_slug")) throw new InvalidStateError("File không thuộc dự án này");
    feature = getFeature(Number(metaMap.get("feature_id")));
    if (feature.project_id !== project.id) throw new InvalidStateError("Nghiệp vụ không thuộc dự án này");
  } else {
    // Another app dropped the hidden _meta sheet when re-saving: infer the feature from the hidden case_id column.
    const caseId = firstId(ws, headerIndex.get(CASE_COL.caseId));
    if (!caseId) throw new InvalidStateError("Không xác định được nghiệp vụ: thiếu sheet _meta và cột case_id trống");
    feature = getFeature(getCase(caseId).feature_id);
  }

  const byId = new Map(listCases(feature.id).map((c) => [c.id, c]));
  const issues: Array<{ row: number; code: string; message: string }> = [];
  const changes: Change[] = [];
  const seen = new Set<number>();

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const get = (name: string) => {
      const col = headerIndex.get(name);
      return col ? cellText(row.getCell(col).value).trim() : "";
    };
    const code = get(CASE_COL.code);
    const idText = get(CASE_COL.caseId);
    const decision = get(CASE_COL.decision);
    const reason = get(CASE_COL.reason) || null;
    if (!code && !idText && !decision) return;
    const c = byId.get(Number(idText));
    if (!idText || !c) {
      issues.push({ row: rowNumber, code, message: "case_id không có hoặc không thuộc nghiệp vụ này (cột ẩn bị sửa/xoá?)" });
      return;
    }
    if (seen.has(c.id)) {
      issues.push({ row: rowNumber, code, message: "Dòng bị trùng" });
      return;
    }
    seen.add(c.id);
    if (decision === "") return;
    if (decision !== DECISION_APPROVE && decision !== DECISION_REJECT) {
      issues.push({ row: rowNumber, code, message: `Đánh giá không hợp lệ: "${decision}"` });
      return;
    }
    const s = c.review_status;
    let action: Change["action"] | null = null;
    if (decision === DECISION_APPROVE) {
      if (s === "rebutted") action = "keep";
      else if (s !== "approved") action = "approve";
    } else if (s === "rebutted") {
      action = "accept_drop";
    } else if (s === "pending" || s === "approved" || (s === "rejected" && reason !== c.reject_reason)) {
      // dropped stays dropped: the file pre-fills "Không duyệt" + the old reason for it
      action = "reject";
    }
    if (action) changes.push({ case_id: c.id, code: c.code, from: s, action, reason });
  });

  const blocked = issues.length > 0 && !options.allow_partial;
  if (!options.dry_run && !blocked) {
    getDb().transaction(() => {
      for (const ch of changes) applyUserDecision(ch.case_id, ch.action, ch.reason);
    })();
  }
  return {
    applied: !options.dry_run && !blocked,
    feature_id: feature.id,
    changes,
    issues,
    review: reviewSummary(feature.id),
  };
}
