import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exportRun } from "../excel/export.js";
import { importResults } from "../excel/import.js";
import {
  attachEvidence,
  createRun,
  DEV_STATUSES,
  EVIDENCE_KINDS,
  finishRun,
  getRun,
  RESULT_STATUSES,
  recordResult,
  runResults,
  runSummary,
  setDevStatus,
} from "../repo/runs.js";
import { cleanupEvidence } from "../storage.js";
import { runSafe } from "./_shared.js";

export function registerRunTools(server: McpServer): void {
  server.registerTool(
    "run_create",
    {
      description:
        "Start a test run. initial: approved cases of feature_id. retest: cases marked 'fixed' by Dev in parent_run_id. case_ids narrows the set.",
      inputSchema: {
        project: z.union([z.string(), z.number()]),
        kind: z.enum(["initial", "retest"]),
        feature_id: z.number().int().optional(),
        parent_run_id: z.number().int().optional(),
        case_ids: z.array(z.number().int()).optional(),
        environment: z.string().nullable().optional(),
        note: z.string().nullable().optional(),
      },
    },
    async (input) =>
      runSafe(() => {
        const { run } = createRun(input);
        return { run, results: runResults(run.id) };
      }),
  );

  server.registerTool(
    "run_get",
    {
      description: "Get a run with every case (steps, expected) and its current result. Use it to drive test execution.",
      inputSchema: { run_id: z.number().int() },
    },
    async ({ run_id }) => runSafe(() => ({ run: getRun(run_id), results: runResults(run_id) })),
  );

  server.registerTool(
    "result_record",
    {
      description: "Record the outcome of one case in a run. Recording again replaces the previous outcome (omitted fields are cleared).",
      inputSchema: {
        run_id: z.number().int(),
        case_id: z.number().int(),
        status: z.enum(RESULT_STATUSES),
        actual: z.string().nullable().optional().describe("What actually happened (required for fail/blocked)"),
        console_errors: z.string().nullable().optional(),
        bug_ref: z.string().nullable().optional().describe("Bug id/link in the user's tracker, if logged"),
      },
    },
    async ({ run_id, case_id, ...input }) => runSafe(() => recordResult(run_id, case_id, input)),
  );

  server.registerTool(
    "evidence_attach",
    {
      description:
        "Store evidence for a case result: copy a screenshot file (source_path, e.g. from browser_take_screenshot) or save text content (console/network log). Files are organised as <project>/<run>/<TC>/.",
      inputSchema: {
        run_id: z.number().int(),
        case_id: z.number().int(),
        kind: z.enum(EVIDENCE_KINDS),
        source_path: z.string().optional(),
        content: z.string().optional(),
        step_no: z.number().int().nullable().optional(),
        caption: z.string().nullable().optional(),
      },
    },
    async ({ run_id, case_id, ...input }) => runSafe(() => attachEvidence(run_id, case_id, input)),
  );

  server.registerTool(
    "dev_status_set",
    {
      description: "Set Dev status of a result: none | fixed | not_bug.",
      inputSchema: {
        result_id: z.number().int(),
        dev_status: z.enum(DEV_STATUSES),
        dev_note: z.string().nullable().optional(),
      },
    },
    async ({ result_id, dev_status, dev_note }) => runSafe(() => setDevStatus(result_id, dev_status, dev_note)),
  );

  server.registerTool(
    "run_finish",
    { description: "Mark a run as finished and return its summary.", inputSchema: { run_id: z.number().int() } },
    async ({ run_id }) =>
      runSafe(() => {
        finishRun(run_id);
        return runSummary(run_id);
      }),
  );

  server.registerTool(
    "run_summary",
    { description: "Pass/fail counts, open bugs and failed cases of a run.", inputSchema: { run_id: z.number().int() } },
    async ({ run_id }) => runSafe(() => runSummary(run_id)),
  );

  server.registerTool(
    "excel_export",
    {
      description: "Export a run to one Excel file (screenshots embedded) saved in the user's Downloads folder. Returns its path.",
      inputSchema: { run_id: z.number().int() },
    },
    async ({ run_id }) => runSafe(() => exportRun(run_id)),
  );

  server.registerTool(
    "excel_import",
    {
      description:
        "Import a result Excel (.xlsx) updated by Dev. Validates project/run/ID columns; any issue blocks the write unless allow_partial. Then creates a retest run for cases marked 'Đã fix'. Use dry_run first to show the user what will change.",
      inputSchema: {
        path: z.string(),
        dry_run: z.boolean().optional(),
        allow_partial: z.boolean().optional(),
        create_retest: z.boolean().optional(),
      },
    },
    async ({ path, ...options }) => runSafe(() => importResults(path, options)),
  );

  server.registerTool(
    "evidence_cleanup",
    {
      description:
        "Delete evidence files of the given runs. confirm=false previews sizes; only call with confirm=true after the user approved that exact list. DB rows are kept and marked as cleaned.",
      inputSchema: { run_ids: z.array(z.number().int()).min(1), confirm: z.boolean() },
    },
    async ({ run_ids, confirm }) => runSafe(() => cleanupEvidence(run_ids, confirm)),
  );
}
