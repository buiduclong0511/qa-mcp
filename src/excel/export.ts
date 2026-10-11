import ExcelJS from "exceljs";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import sharp from "sharp";
import { readConfig } from "../config.js";
import { getProject } from "../repo/projects.js";
import { evidenceAbsPath, getRun, runResults, runSummary } from "../repo/runs.js";
import {
  COL,
  DEV_LABELS,
  META_SCHEMA,
  META_SHEET,
  META_VERSION,
  PRIORITY_LABELS,
  RESULT_LABELS,
  RESULT_SHEET,
  SUMMARY_SHEET,
  TYPE_LABELS,
} from "./labels.js";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const THUMB_DISPLAY_WIDTH = 160;

const STATUS_FILL: Record<string, string> = {
  pass: "FFDCFCE7",
  fail: "FFFEE2E2",
  blocked: "FFFEF3C7",
  skipped: "FFF1F5F9",
  pending: "FFF1F5F9",
};

export function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

export interface ExportResult {
  xlsx: string;
  rows: number;
  images: number;
}

/** Excel files (test case review, results) are written to the user's Downloads folder. */
export function downloadsDir(): string {
  return process.env.QA_DOWNLOADS_DIR || join(homedir(), "Downloads");
}

export function styleHeader(ws: ExcelJS.Worksheet): void {
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 28;
}

export async function exportRun(runId: number): Promise<ExportResult> {
  const run = getRun(runId);
  const project = getProject(run.project_id);
  const summary = runSummary(runId);
  const results = runResults(runId);
  const { thumbnailWidth } = readConfig();

  const baseName = `${project.slug}-run${run.id}-${timestamp()}`;
  mkdirSync(downloadsDir(), { recursive: true });

  const wb = new ExcelJS.Workbook();
  wb.creator = "qa-mcp";
  wb.created = new Date();

  // Summary sheet
  const s = wb.addWorksheet(SUMMARY_SHEET);
  s.columns = [{ width: 26 }, { width: 60 }];
  const summaryRows: Array<[string, string | number]> = [
    ["Dự án", project.name],
    ["URL", project.base_url],
    ["Nghiệp vụ", summary.feature?.title ?? "—"],
    ["Lượt test", `#${run.id} (${run.kind === "initial" ? "Test lần đầu" : `Retest từ lượt #${run.parent_run_id}`})`],
    ["Môi trường", run.environment ?? "—"],
    ["Bắt đầu", run.started_at],
    ["Kết thúc", run.finished_at ?? "—"],
    ["Tổng số case", summary.total],
    ["Pass", summary.counts.pass],
    ["Fail", summary.counts.fail],
    ["Blocked", summary.counts.blocked],
    ["Bỏ qua", summary.counts.skipped],
    ["Chưa test", summary.counts.pending],
    ["Bug còn mở", summary.open_bugs],
  ];
  s.addRow(["Báo cáo kết quả test"]).font = { bold: true, size: 14 };
  s.addRow([]);
  for (const row of summaryRows) {
    const r = s.addRow(row);
    r.getCell(1).font = { bold: true };
  }

  // Results sheet
  const ws = wb.addWorksheet(RESULT_SHEET, { views: [{ state: "frozen", ySplit: 1 }] });
  const columns: Array<{ header: string; key: keyof typeof COL; width: number; hidden?: boolean }> = [
    { header: COL.code, key: "code", width: 10 },
    { header: COL.page, key: "page", width: 18 },
    { header: COL.type, key: "type", width: 16 },
    { header: COL.priority, key: "priority", width: 11 },
    { header: COL.title, key: "title", width: 36 },
    { header: COL.preconditions, key: "preconditions", width: 26 },
    { header: COL.steps, key: "steps", width: 44 },
    { header: COL.testData, key: "testData", width: 22 },
    { header: COL.expected, key: "expected", width: 34 },
    { header: COL.actual, key: "actual", width: 34 },
    { header: COL.status, key: "status", width: 11 },
    { header: COL.bug, key: "bug", width: 14 },
    { header: COL.image, key: "image", width: 24 },
    { header: COL.devStatus, key: "devStatus", width: 18 },
    { header: COL.devNote, key: "devNote", width: 30 },
    { header: COL.caseId, key: "caseId", width: 8, hidden: true },
    { header: COL.resultId, key: "resultId", width: 8, hidden: true },
    { header: COL.runId, key: "runId", width: 8, hidden: true },
    { header: COL.devStatusExported, key: "devStatusExported", width: 8, hidden: true },
    { header: COL.devNoteExported, key: "devNoteExported", width: 8, hidden: true },
  ];
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width, hidden: c.hidden }));
  styleHeader(ws);

  const imageCol = columns.findIndex((c) => c.key === "image");
  let imageCount = 0;

  for (const r of results) {
    const screenshots = r.evidence.filter((e) => e.kind === "screenshot" && IMAGE_EXT.has(extname(e.path).toLowerCase()));
    const live = screenshots.filter((e) => !e.cleaned_at && existsSync(evidenceAbsPath(e.path)));
    let imageLabel = "";
    if (screenshots.length > 0 && live.length === 0) imageLabel = "Ảnh đã dọn";

    const row = ws.addRow({
      code: r.code,
      page: r.page_name ?? "",
      type: TYPE_LABELS[r.type] ?? r.type,
      priority: PRIORITY_LABELS[r.priority] ?? r.priority,
      title: r.title,
      preconditions: r.preconditions ?? "",
      steps: r.steps.map((step, i) => `${i + 1}. ${step}`).join("\n"),
      testData: r.test_data ?? "",
      expected: r.expected,
      actual: r.actual ?? "",
      status: RESULT_LABELS[r.status] ?? r.status,
      bug: r.bug_ref ?? "",
      image: imageLabel,
      devStatus: DEV_LABELS[r.dev_status],
      devNote: r.dev_note ?? "",
      caseId: r.case_id,
      resultId: r.id,
      runId: run.id,
      devStatusExported: DEV_LABELS[r.dev_status],
      devNoteExported: r.dev_note ?? "",
    });
    row.alignment = { vertical: "top", wrapText: true };
    row.getCell("status").fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: STATUS_FILL[r.status] ?? STATUS_FILL.pending },
    };
    row.getCell("devStatus").dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [`"${Object.values(DEV_LABELS).join(",")}"`],
      showErrorMessage: true,
      errorTitle: "Giá trị không hợp lệ",
      error: `Chọn một trong: ${Object.values(DEV_LABELS).join(", ")}`,
    };

    if (live.length > 0) {
      // The screenshot is embedded in the file (shown small in the cell, full detail when enlarged in Excel).
      const thumb = await sharp(evidenceAbsPath(live[0].path))
        .resize({ width: thumbnailWidth, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer({ resolveWithObject: true });
      const ratio = thumb.info.height / thumb.info.width;
      const displayHeight = Math.round(THUMB_DISPLAY_WIDTH * ratio);
      const imageId = wb.addImage({ buffer: thumb.data as unknown as ExcelJS.Buffer, extension: "jpeg" });
      ws.addImage(imageId, {
        tl: { col: imageCol + 0.05, row: row.number - 1 + 0.05 },
        ext: { width: THUMB_DISPLAY_WIDTH, height: displayHeight },
        editAs: "oneCell",
      });
      row.height = Math.max(row.height ?? 15, Math.round(displayHeight * 0.75) + 6);
      imageCount++;
    }
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length - 5 } };

  // Meta sheet, used by import to make sure the file belongs to this project/run
  const meta = wb.addWorksheet(META_SHEET, { state: "veryHidden" });
  meta.addRows([
    ["schema", META_SCHEMA],
    ["version", META_VERSION],
    ["project_id", project.id],
    ["project_slug", project.slug],
    ["run_id", run.id],
    ["exported_at", new Date().toISOString()],
  ]);

  const xlsx = join(downloadsDir(), `${baseName}.xlsx`);
  await wb.xlsx.writeFile(xlsx);

  return { xlsx, rows: results.length, images: imageCount };
}
