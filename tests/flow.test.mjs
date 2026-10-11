import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import ExcelJS from "exceljs";
import sharp from "sharp";

const home = mkdtempSync(join(tmpdir(), "qa-mcp-test-"));
process.env.QA_MCP_HOME = home;
// Never touch the real machine's Playwright folders from tests
process.env.QA_PW_LEGACY_DIR = join(home, "legacy");
process.env.QA_NPX_DIR = join(home, "npx");
process.env.QA_TMP_DIR = join(home, "tmp");
process.env.PLAYWRIGHT_BROWSERS_PATH = join(home, "browsers");
process.env.QA_DOWNLOADS_DIR = join(home, "Downloads");

const { upsertProject, setPolicy, upsertPages, getProject } = await import("../dist/repo/projects.js");
const cases = await import("../dist/repo/cases.js");
const runs = await import("../dist/repo/runs.js");
const { exportRun } = await import("../dist/excel/export.js");
const { importResults } = await import("../dist/excel/import.js");
const storage = await import("../dist/storage.js");
const { writeConfig } = await import("../dist/config.js");
const { pwPaths } = await import("../dist/maintenance/paths.js");
const { exportCases, importCases } = await import("../dist/excel/cases.js");
const { closeDb } = await import("../dist/db/index.js");

let project, feature, tc, run, shot;

before(async () => {
  shot = join(home, "shot.png");
  await sharp({ create: { width: 1280, height: 800, channels: 3, background: "#ff0000" } }).png().toFile(shot);
});

after(async () => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

describe("project onboarding", () => {
  test("upsert project, policy, pages with related links", () => {
    project = upsertProject({ name: "Shop Demo Đẹp", base_url: "https://shop.example.com", environment: "staging" });
    assert.equal(project.slug, "shop-demo-dep");
    const again = upsertProject({ name: "Shop Demo Đẹp", base_url: "https://shop.example.com", overview: "Bán hàng" });
    assert.equal(again.id, project.id);
    assert.equal(again.environment, "staging", "omitted fields are kept");

    const policy = setPolicy(project.id, { can_create: true, test_data_rule: "[QA] prefix", confirmed_by_user: true });
    assert.equal(policy.can_create, 1);
    assert.equal(policy.can_delete, 0);
    assert.ok(policy.confirmed_at);

    const pages = upsertPages(project.id, [
      { name: "Giỏ hàng", url: "/cart", related_pages: ["Thanh toán"] },
      { name: "Thanh toán", url: "/checkout" },
    ]);
    assert.deepEqual(pages[0].related_page_ids, [pages[1].id]);
    assert.throws(() => upsertPages(project.id, [{ name: "X", related_pages: ["Không có"] }]), /not found/);
  });
});

describe("test cases and review", () => {
  test("create cases with auto codes", () => {
    feature = cases.createFeature(project.id, "Mã giảm giá", "Áp mã giảm 10%", []);
    tc = cases.createCases(feature.id, [
      { title: "Áp mã hợp lệ", type: "functional", steps: ["Mở giỏ", "Nhập mã"], expected: "Giảm 10%" },
      { title: "Mã hết hạn", type: "edge", steps: ["Nhập mã cũ"], expected: "Báo lỗi" },
      { title: "Mã rỗng", type: "negative", steps: ["Bấm áp dụng"], expected: "Báo bắt buộc" },
      { title: "Case thừa", type: "ui", steps: ["Xem"], expected: "OK" },
    ]);
    assert.deepEqual(tc.map((c) => c.code), ["TC-001", "TC-002", "TC-003", "TC-004"]);
  });

  test("review flow: approve, reject with/without reason, rebut, keep, concede", () => {
    cases.applyUserDecision(tc[0].id, "approve");
    assert.equal(cases.applyUserDecision(tc[3].id, "reject", "  ").review_status, "dropped");
    assert.equal(cases.applyUserDecision(tc[1].id, "reject", "Trùng").review_status, "rejected");
    assert.equal(cases.applyUserDecision(tc[2].id, "reject", "Không cần").review_status, "rejected");

    let summary = cases.reviewSummary(feature.id);
    assert.equal(summary.need_rebuttal.length, 2);
    assert.equal(summary.review_done, false);

    assert.throws(() => cases.rebutCase(tc[0].id, "x", false), /only "rejected"/);
    assert.equal(cases.rebutCase(tc[1].id, "Mã hết hạn là rủi ro cao", false).review_status, "rebutted");
    assert.equal(cases.rebutCase(tc[2].id, null, true).review_status, "dropped");
    assert.throws(() => cases.applyUserDecision(tc[0].id, "keep"), /not waiting/);
    assert.equal(cases.applyUserDecision(tc[1].id, "keep").review_status, "approved");

    summary = cases.reviewSummary(feature.id);
    assert.equal(summary.review_done, true);
    assert.equal(summary.counts.approved, 2);
  });

  test("review via Excel: export, user fills Đánh giá/Lý do, import, rebuttal round", async () => {
    const extra = cases.createCases(feature.id, [
      { title: "Case review Excel 1", type: "ui", steps: ["Xem"], expected: "OK" },
      { title: "Case review Excel 2", type: "ui", steps: ["Xem"], expected: "OK" },
    ]);
    const first = await exportCases(feature.id);
    assert.ok(first.xlsx.startsWith(join(home, "Downloads")));

    const fill = async (file, edits) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(file);
      const ws = wb.getWorksheet("Test case");
      const h = {};
      ws.getRow(1).eachCell((c, i) => (h[c.value] = i));
      ws.eachRow((row, n) => {
        if (n === 1) return;
        const e = edits[row.getCell(h.case_id).value];
        if (!e) return;
        row.getCell(h["Đánh giá"]).value = e[0];
        if (e[1] !== undefined) row.getCell(h["Lý do"]).value = e[1];
      });
      const out = join(home, `review-${Date.now()}.xlsx`);
      await wb.xlsx.writeFile(out);
      return { out, h, ws };
    };

    const r1 = await fill(first.xlsx, { [extra[0].id]: ["Duyệt"], [extra[1].id]: ["Không duyệt", "Trùng TC-001"] });
    const res1 = await importCases(r1.out);
    assert.equal(res1.applied, true);
    assert.equal(cases.getCase(extra[0].id).review_status, "approved");
    assert.equal(cases.getCase(extra[1].id).review_status, "rejected");
    assert.ok(res1.review.need_rebuttal.some((c) => c.id === extra[1].id));

    cases.rebutCase(extra[1].id, "Khác TC-001 ở bước 2", false);
    const second = await exportCases(feature.id);
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.readFile(second.xlsx);
    const ws2 = wb2.getWorksheet("Test case");
    const row = [...Array(ws2.rowCount).keys()].map((i) => ws2.getRow(i + 1)).find((r) => r.getCell(r1.h.case_id).value === extra[1].id);
    assert.equal(row.getCell(r1.h["Phản biện của AI"]).value, "Khác TC-001 ở bước 2");
    assert.equal(row.getCell(r1.h["Đánh giá"]).value ?? "", "", "rebutted case needs a new decision");

    const r2 = await fill(second.xlsx, { [extra[1].id]: ["Duyệt"] });
    await importCases(r2.out);
    assert.equal(cases.getCase(extra[1].id).review_status, "approved", "Duyệt after rebuttal keeps the case");

    // _meta dropped by another app: feature inferred from case_id
    const wbNoMeta = new ExcelJS.Workbook();
    await wbNoMeta.xlsx.readFile(second.xlsx);
    wbNoMeta.removeWorksheet(wbNoMeta.getWorksheet("_meta").id);
    const noMetaCases = join(home, "cases-no-meta.xlsx");
    await wbNoMeta.xlsx.writeFile(noMetaCases);
    assert.equal((await importCases(noMetaCases, { dry_run: true })).feature_id, feature.id);

    const bad = await fill(second.xlsx, { [extra[0].id]: ["Có lẽ"] });
    const res3 = await importCases(bad.out);
    assert.equal(res3.applied, false);
    assert.equal(res3.issues.length, 1);

    // keep later tests' fixture unchanged
    for (const c of extra) cases.applyUserDecision(c.id, "reject", "");
  });
});

describe("runs, evidence, excel round trip", () => {
  test("initial run only takes approved cases", () => {
    const created = runs.createRun({ project: project.slug, kind: "initial", feature_id: feature.id });
    run = created.run;
    assert.deepEqual(created.case_ids, [tc[0].id, tc[1].id]);
    assert.throws(
      () => runs.createRun({ project: project.id, kind: "initial", feature_id: feature.id, case_ids: [tc[3].id] }),
      /not approved/,
    );
  });

  test("record results and attach evidence", () => {
    runs.recordResult(run.id, tc[0].id, { status: "pass" });
    runs.recordResult(run.id, tc[1].id, { status: "fail", actual: "Vẫn giảm giá", bug_ref: "BUG-1" });
    const ev = runs.attachEvidence(run.id, tc[1].id, { kind: "screenshot", source_path: shot, step_no: 1, caption: "Lỗi" });
    assert.equal(ev.path, join("shop-demo-dep", String(run.id), "TC-002", "01-step1-screenshot.png"));
    assert.ok(existsSync(runs.evidenceAbsPath(ev.path)));
    runs.attachEvidence(run.id, tc[1].id, { kind: "console", content: "TypeError: x" });
    assert.throws(() => runs.attachEvidence(run.id, tc[3].id, { kind: "console", content: "x" }), /not part of run/);

    // Relative path from Playwright's own cwd resolves via the shared output folder
    mkdirSync(pwPaths.output(), { recursive: true });
    copyFileSync(shot, join(pwPaths.output(), "page-x.png"));
    const viaOutput = runs.attachEvidence(run.id, tc[1].id, { kind: "screenshot", source_path: "../../elsewhere/page-x.png" });
    assert.match(viaOutput.path, /03-screenshot\.png$/);
    assert.throws(() => runs.attachEvidence(run.id, tc[1].id, { kind: "screenshot", source_path: "nope.png" }), /File not found/);
    const s = runs.runSummary(run.id);
    assert.equal(s.counts.pass, 1);
    assert.equal(s.open_bugs, 1);
  });

  test("export, Dev edits Excel, import creates retest run", async () => {
    const out = await exportRun(run.id);
    assert.ok(existsSync(out.xlsx));
    assert.ok(out.xlsx.startsWith(join(home, "Downloads")), "Xuất Excel saves into Downloads");
    assert.equal(out.images, 1);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out.xlsx);
    const ws = wb.getWorksheet("Kết quả");
    const headers = {};
    ws.getRow(1).eachCell((c, i) => (headers[c.value] = i));
    assert.equal(ws.getColumn(headers.result_id).hidden, true);
    assert.equal(wb.getWorksheet("_meta").state, "veryHidden");
    const failRow = [2, 3].map((n) => ws.getRow(n)).find((r) => r.getCell(headers["Mã TC"]).value === "TC-002");
    failRow.getCell(headers["Trạng thái Dev"]).value = "Đã fix";
    failRow.getCell(headers["Ghi chú Dev"]).value = "Fix ở v1.2";
    const edited = join(home, "edited.xlsx");
    await wb.xlsx.writeFile(edited);

    const dry = await importResults(edited, { dry_run: true });
    assert.equal(dry.applied, false);
    assert.equal(dry.issues.length, 0);

    const res = await importResults(edited);
    assert.equal(res.applied, true);
    assert.equal(res.retest_case_count, 1);
    const retest = runs.getRun(res.retest_run_id);
    assert.equal(retest.kind, "retest");
    assert.equal(retest.parent_run_id, run.id);
    assert.deepEqual(runs.runResults(retest.id).map((r) => r.code), ["TC-002"]);

  });

  test("import blocks when ID columns are tampered with", async () => {
    const out = await exportRun(run.id);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out.xlsx);
    const ws = wb.getWorksheet("Kết quả");
    const headers = {};
    ws.getRow(1).eachCell((c, i) => (headers[c.value] = i));
    ws.getRow(2).getCell(headers.result_id).value = null;
    ws.getRow(3).getCell(headers["Trạng thái Dev"]).value = "Xong rồi";
    const bad = join(home, "bad.xlsx");
    await wb.xlsx.writeFile(bad);
    const res = await importResults(bad);
    assert.equal(res.applied, false);
    assert.equal(res.issues.length, 2);

    const other = join(home, "other.xlsx");
    const plain = new ExcelJS.Workbook();
    plain.addWorksheet("Sheet1");
    await plain.xlsx.writeFile(other);
    await assert.rejects(importResults(other), /Không phải file kết quả của qa-mcp/);

    // Re-saved by another app that drops the hidden _meta sheet: run inferred from result_id; quoted file:// path accepted
    const noMeta = new ExcelJS.Workbook();
    await noMeta.xlsx.readFile(out.xlsx);
    noMeta.removeWorksheet(noMeta.getWorksheet("_meta").id);
    const noMetaFile = join(home, "no meta.xlsx");
    await noMeta.xlsx.writeFile(noMetaFile);
    const { pathToFileURL } = await import("node:url");
    const inferred = await importResults(`"${pathToFileURL(noMetaFile).href}"`, { dry_run: true });
    assert.equal(inferred.source_run_id, run.id);
    assert.equal(inferred.issues.length, 0);

    // A test case file sent to the results import is rejected with a clear message
    const caseFile = await exportCases(feature.id);
    await assert.rejects(importResults(caseFile.xlsx), /file test case, dùng cases_import/);
    await assert.rejects(importCases(out.xlsx), /file kết quả test, dùng excel_import/);
  });
});

describe("storage", () => {
  test("reports Playwright leftovers", () => {
    const check = storage.storageCheck();
    assert.equal(typeof check.playwright.total_gb, "number");
    assert.match(check.playwright.cleanup_command, /maintenance.cli\.js" cleanup$/);
  });

  test("warns at threshold and protects groups with open bugs", () => {
    let check = storage.storageCheck();
    assert.equal(check.warn, false);
    assert.equal(check.groups, undefined);

    writeConfig({ storageLimitGb: 0.000001 });
    check = storage.storageCheck();
    assert.equal(check.warn, true);
    const group = check.groups.find((g) => g.run_id === run.id);
    assert.equal(group.open_bugs, 1, "TC-002 was fixed but not retested yet");
    assert.equal(group.suggested, false);
  });

  test("cleanup previews first, then deletes files and keeps rows", () => {
    const preview = storage.cleanupEvidence([run.id], false);
    assert.equal(preview.dry_run, true);
    assert.ok(preview.total_mb >= 0);
    const ev = runs.runResults(run.id).flatMap((r) => r.evidence);
    assert.ok(ev.every((e) => existsSync(runs.evidenceAbsPath(e.path))));

    storage.cleanupEvidence([run.id], true);
    const after = runs.runResults(run.id).flatMap((r) => r.evidence);
    assert.ok(after.length > 0 && after.every((e) => e.cleaned_at));
    assert.ok(after.every((e) => !existsSync(runs.evidenceAbsPath(e.path))));
    writeConfig({ storageLimitGb: 5 });
  });
});
