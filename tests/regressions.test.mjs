import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import ExcelJS from "exceljs";

const home = mkdtempSync(join(tmpdir(), "qa-mcp-reg-"));
process.env.QA_MCP_HOME = home;
process.env.QA_DOWNLOADS_DIR = join(home, "Downloads");
process.env.QA_PW_LEGACY_DIR = join(home, "legacy");
process.env.QA_NPX_DIR = join(home, "npx");

const { upsertProject } = await import("../dist/repo/projects.js");
const cases = await import("../dist/repo/cases.js");
const runs = await import("../dist/repo/runs.js");
const { exportCases, importCases } = await import("../dist/excel/cases.js");
const { exportRun } = await import("../dist/excel/export.js");
const { importResults } = await import("../dist/excel/import.js");
const { closeDb } = await import("../dist/db/index.js");

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

const project = upsertProject({ name: "Reg", base_url: "https://reg.example.com" });
const feature = cases.createFeature(project.id, "F", "R", []);
const [a, b, c] = cases.createCases(feature.id, [
  { title: "A", type: "functional", steps: ["x"], expected: "y" },
  { title: "B", type: "functional", steps: ["x"], expected: "y" },
  { title: "C", type: "functional", steps: ["x"], expected: "y" },
]);

async function setCells(file, sheet, keyCol, edits) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(sheet);
  const h = {};
  ws.getRow(1).eachCell((cell, i) => (h[cell.value] = i));
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const e = edits[row.getCell(h[keyCol]).value];
    if (e) for (const [col, v] of Object.entries(e)) row.getCell(h[col]).value = v;
  });
  const out = join(home, `edit-${Math.random().toString(36).slice(2)}.xlsx`);
  await wb.xlsx.writeFile(out);
  return out;
}

test("a dropped case does not come back when the review file is re-imported unchanged", async () => {
  cases.applyUserDecision(a.id, "approve");
  cases.applyUserDecision(b.id, "approve");
  cases.applyUserDecision(c.id, "reject", "Trùng");
  cases.rebutCase(c.id, null, true);
  const file = await exportCases(feature.id);
  const res = await importCases(file.xlsx);
  assert.equal(cases.getCase(c.id).review_status, "dropped");
  assert.equal(res.changes.length, 0);
});

test("same name for a different site is refused instead of merged", () => {
  assert.throws(() => upsertProject({ name: "reg", base_url: "https://other.example.com" }), /đã dùng cho/);
  assert.equal(upsertProject({ name: "Reg", base_url: "https://reg.example.com/path" }).id, project.id);
});

test("re-recording a result clears the old failure details", () => {
  const { run } = runs.createRun({ project: project.id, kind: "initial", feature_id: feature.id });
  runs.recordResult(run.id, a.id, { status: "fail", actual: "Lỗi", bug_ref: "BUG-1" });
  const r = runs.recordResult(run.id, a.id, { status: "pass" });
  assert.equal(r.actual, null);
  assert.equal(r.bug_ref, null);
});

test("results import: idempotent retest, change-only apply, pass rows not retested", async () => {
  const { run } = runs.createRun({ project: project.id, kind: "initial", feature_id: feature.id });
  runs.recordResult(run.id, a.id, { status: "fail", actual: "Lỗi" });
  runs.recordResult(run.id, b.id, { status: "pass" });
  const exported = await exportRun(run.id);
  const resultOf = (caseId) => runs.runResults(run.id).find((r) => r.case_id === caseId);

  const devFile = await setCells(exported.xlsx, "Kết quả", "case_id", {
    [a.id]: { "Trạng thái Dev": "Đã fix" },
    [b.id]: { "Trạng thái Dev": "Đã fix" },
  });
  const first = await importResults(devFile);
  assert.equal(first.retest_case_count, 1, "only the failed case is retested");
  assert.ok(first.warnings.some((w) => /bỏ qua khi retest/.test(w.message)));
  const again = await importResults(devFile);
  assert.equal(again.retest_run_id, null, "same file twice does not create a second retest run");

  // Status set from chat after export must survive an old file where the Dev left the cell untouched
  runs.setDevStatus(resultOf(b.id).id, "not_bug", "từ chat");
  const stale = await setCells(exported.xlsx, "Kết quả", "case_id", { [a.id]: { "Ghi chú Dev": "đã sửa ở v2" } });
  await importResults(stale, { create_retest: false });
  assert.equal(resultOf(b.id).dev_status, "not_bug");
  assert.equal(resultOf(b.id).dev_note, "từ chat");
  assert.equal(resultOf(a.id).dev_note, "đã sửa ở v2");
});
