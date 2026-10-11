import ExcelJS from "exceljs";
import { getDb } from "../db/index.js";
import { InvalidStateError } from "../repo/cases.js";
import { getProject } from "../repo/projects.js";
import { createRun, getResult, getRun, type DevStatus } from "../repo/runs.js";
import { cellText, firstId, headerIndex as readHeader, normalizeUserPath, readMeta } from "./common.js";
import { CASES_SHEET, COL, devStatusFromLabel, META_SCHEMA, RESULT_SHEET } from "./labels.js";

export interface ImportIssue {
  row?: number;
  code?: string;
  message: string;
}

export interface ImportOutcome {
  applied: boolean;
  project: string;
  source_run_id: number;
  updates: Array<{ result_id: number; code: string; dev_status: DevStatus; dev_note: string | null }>;
  issues: ImportIssue[];
  warnings: ImportIssue[];
  retest_run_id: number | null;
  retest_case_count: number;
}

export interface ImportOptions {
  /** Validate only, write nothing. */
  dry_run?: boolean;
  /** Apply valid rows even if some rows have issues. Default false: any issue blocks the import. */
  allow_partial?: boolean;
  /** Create a retest run for the cases marked "Đã fix". Default true. */
  create_retest?: boolean;
}

export async function importResults(file: string, options: ImportOptions = {}): Promise<ImportOutcome> {
  file = normalizeUserPath(file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const ws = wb.getWorksheet(RESULT_SHEET);
  const metaMap = readMeta(wb);
  if (metaMap?.get("schema") === "qa-mcp-cases" || (!ws && wb.getWorksheet(CASES_SHEET))) {
    throw new InvalidStateError("Đây là file test case, dùng cases_import");
  }
  if (!ws) throw new InvalidStateError(`Không phải file kết quả của qa-mcp: thiếu sheet "${RESULT_SHEET}"`);
  const headerIndex = readHeader(ws);
  for (const required of [COL.resultId, COL.caseId, COL.devStatus]) {
    if (!headerIndex.has(required)) throw new InvalidStateError(`Column "${required}" not found in sheet "${RESULT_SHEET}"`);
  }

  let sourceRun;
  if (metaMap) {
    if (metaMap.get("schema") !== META_SCHEMA) throw new InvalidStateError("Not a qa-mcp result file: unknown schema");
    const project = getProject(Number(metaMap.get("project_id")));
    if (project.slug !== metaMap.get("project_slug")) {
      throw new InvalidStateError(
        `Project mismatch: file is for "${metaMap.get("project_slug")}", database has "${project.slug}" with that id`,
      );
    }
    sourceRun = getRun(Number(metaMap.get("run_id")));
    if (sourceRun.project_id !== project.id) throw new InvalidStateError(`Run ${sourceRun.id} does not belong to ${project.slug}`);
  } else {
    // Another app dropped the hidden _meta sheet when re-saving: infer the run from the hidden result_id column.
    const resultId = firstId(ws, headerIndex.get(COL.resultId));
    if (!resultId) throw new InvalidStateError("Không xác định được lượt test: thiếu sheet _meta và cột result_id trống");
    sourceRun = getRun(getResult(resultId).run_id);
  }
  const project = getProject(sourceRun.project_id);

  const col = (name: string) => headerIndex.get(name);

  const db = getDb();
  const runResults = db
    .prepare(
      "SELECT r.id, r.case_id, r.status, r.dev_status, r.dev_note, c.code FROM results r JOIN test_cases c ON c.id = r.case_id WHERE r.run_id = ?",
    )
    .all(sourceRun.id) as Array<{ id: number; case_id: number; status: string; dev_status: DevStatus; dev_note: string | null; code: string }>;
  const byResultId = new Map(runResults.map((r) => [r.id, r]));

  const issues: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const updates: ImportOutcome["updates"] = [];
  const seen = new Set<number>();

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const get = (name: string) => {
      const c = col(name);
      return c ? cellText(row.getCell(c).value).trim() : "";
    };
    const code = get(COL.code);
    const resultIdText = get(COL.resultId);
    const caseIdText = get(COL.caseId);
    const devLabel = get(COL.devStatus);
    const devNote = get(COL.devNote) || null;
    const hasSnapshot = col(COL.devStatusExported) !== undefined;
    const exportedLabel = get(COL.devStatusExported);
    const exportedNote = get(COL.devNoteExported) || null;
    if (!code && !resultIdText && !caseIdText && !devLabel && !devNote) return;

    if (!resultIdText || !caseIdText) {
      issues.push({ row: rowNumber, code, message: "Thiếu result_id hoặc case_id (cột ID ẩn bị xoá/sửa)" });
      return;
    }
    const result = byResultId.get(Number(resultIdText));
    if (!result) {
      issues.push({ row: rowNumber, code, message: `result_id ${resultIdText} không thuộc lượt test #${sourceRun.id}` });
      return;
    }
    if (result.case_id !== Number(caseIdText)) {
      issues.push({ row: rowNumber, code, message: "case_id không khớp với result_id" });
      return;
    }
    if (seen.has(result.id)) {
      issues.push({ row: rowNumber, code, message: "Dòng bị trùng" });
      return;
    }
    seen.add(result.id);
    // Blank cell = no change.
    const devStatus = devLabel === "" ? result.dev_status : devStatusFromLabel(devLabel);
    if (!devStatus) {
      issues.push({ row: rowNumber, code, message: `Trạng thái Dev không hợp lệ: "${devLabel}"` });
      return;
    }
    if (code && code !== result.code) warnings.push({ row: rowNumber, code, message: `Mã TC trong file khác DB (${result.code})` });
    // Apply only what the Dev changed in this file (older files without the snapshot: apply as is).
    const statusChanged = !hasSnapshot || devLabel !== exportedLabel;
    const noteChanged = !hasSnapshot || devNote !== exportedNote;
    if (!statusChanged && !noteChanged) return;
    updates.push({
      result_id: result.id,
      code: result.code,
      dev_status: (statusChanged ? devStatus : result.dev_status) as DevStatus,
      dev_note: noteChanged ? devNote : result.dev_note,
    });
  });

  for (const r of runResults) {
    if (!seen.has(r.id) && r.status === "fail") {
      warnings.push({ code: r.code, message: "Case Fail này không có trong file (dòng bị xoá?)" });
    }
  }

  const blocked = issues.length > 0 && !options.allow_partial;
  const base = {
    project: project.slug,
    source_run_id: sourceRun.id,
    updates,
    issues,
    warnings,
  };
  if (options.dry_run || blocked) {
    return { ...base, applied: false, retest_run_id: null, retest_case_count: 0 };
  }

  const apply = db.prepare("UPDATE results SET dev_status = ?, dev_note = ? WHERE id = ?");
  db.transaction(() => {
    for (const u of updates) apply.run(u.dev_status, u.dev_note, u.result_id);
  })();

  let retestRunId: number | null = null;
  let retestCount = 0;
  // Retest only failed/blocked cases marked "Đã fix" that are not already in a retest of this run,
  // so importing the same file twice does not create duplicate retest runs.
  const alreadyRetested = new Set(
    (db
      .prepare("SELECT r.case_id FROM results r JOIN runs u ON u.id = r.run_id WHERE u.parent_run_id = ?")
      .all(sourceRun.id) as Array<{ case_id: number }>).map((r) => r.case_id),
  );
  const toRetest: number[] = [];
  for (const r of runResults) {
    const devStatus = updates.find((u) => u.result_id === r.id)?.dev_status ?? r.dev_status;
    if (devStatus !== "fixed") continue;
    if (r.status !== "fail" && r.status !== "blocked") {
      warnings.push({ code: r.code, message: `Case ${r.status} được đánh "Đã fix", bỏ qua khi retest` });
    } else if (alreadyRetested.has(r.case_id)) {
      warnings.push({ code: r.code, message: "Đã có trong một lượt retest trước, không tạo lại" });
    } else {
      toRetest.push(r.case_id);
    }
  }
  if (options.create_retest !== false && toRetest.length > 0) {
    const { run, case_ids } = createRun({
      project: project.id,
      kind: "retest",
      parent_run_id: sourceRun.id,
      case_ids: toRetest,
      source_excel: file,
    });
    retestRunId = run.id;
    retestCount = case_ids.length;
  }
  return { ...base, applied: true, retest_run_id: retestRunId, retest_case_count: retestCount };
}
