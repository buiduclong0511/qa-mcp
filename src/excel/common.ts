import ExcelJS from "exceljs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InvalidStateError } from "../repo/cases.js";
import { NotFoundError } from "../repo/projects.js";
import { META_SHEET } from "./labels.js";

export function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((t) => t.text).join("");
    if ("text" in value) return String(value.text);
    if ("result" in value) return String(value.result ?? "");
  }
  return String(value);
}

/** Paths pasted into a prompt may carry quotes, "~" or a file:// URL (dragged from Finder/Explorer). */
export function normalizeUserPath(input: string): string {
  let p = input.trim().replace(/^["']|["']$/g, "");
  if (p.startsWith("file://")) p = fileURLToPath(p);
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = homedir() + p.slice(1);
  const file = resolve(p);
  if (!existsSync(file)) throw new NotFoundError(`File not found: ${file}`);
  if (extname(file).toLowerCase() !== ".xlsx") throw new InvalidStateError("Chỉ nạp được file .xlsx");
  return file;
}

/** The hidden _meta sheet as a map; null when another app dropped it while re-saving the file. */
export function readMeta(wb: ExcelJS.Workbook): Map<string, string> | null {
  const meta = wb.getWorksheet(META_SHEET);
  if (!meta) return null;
  const map = new Map<string, string>();
  meta.eachRow((row) => map.set(cellText(row.getCell(1).value), cellText(row.getCell(2).value)));
  return map;
}

/** Column index by header text (row 1). */
export function headerIndex(ws: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>();
  ws.getRow(1).eachCell((cell, col) => map.set(cellText(cell.value).trim(), col));
  return map;
}

/** First non-empty numeric value in a column, used to infer the run/feature when _meta is gone. */
export function firstId(ws: ExcelJS.Worksheet, col: number | undefined): number | null {
  if (!col) return null;
  for (let r = 2; r <= ws.rowCount; r++) {
    const v = Number(cellText(ws.getRow(r).getCell(col).value).trim());
    if (Number.isInteger(v) && v > 0) return v;
  }
  return null;
}
