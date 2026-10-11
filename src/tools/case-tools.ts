import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CASE_TYPES,
  createCases,
  createFeature,
  getFeature,
  listCases,
  PRIORITIES,
  rebutCase,
  REVIEW_STATUSES,
  reviewSummary,
  updateCase,
  updateFeature,
} from "../repo/cases.js";
import { getProject } from "../repo/projects.js";
import { listRuns } from "../repo/runs.js";
import { exportCases, importCases } from "../excel/cases.js";
import { runSafe } from "./_shared.js";

const caseShape = {
  title: z.string(),
  type: z.enum(CASE_TYPES).describe("functional | edge | negative | permission | impact (other pages affected) | ui | other"),
  priority: z.enum(PRIORITIES).optional(),
  page_id: z.number().int().nullable().optional(),
  preconditions: z.string().nullable().optional(),
  steps: z.array(z.string()).min(1),
  expected: z.string(),
  test_data: z.string().nullable().optional(),
};

export function registerCaseTools(server: McpServer): void {
  server.registerTool(
    "feature_create",
    {
      description: "Save a business feature the user wants tested, with the ids of the pages involved (new and affected).",
      inputSchema: {
        project: z.union([z.string(), z.number()]),
        title: z.string(),
        requirement: z.string().describe("Business requirement as given by the user, plus clarifications"),
        page_ids: z.array(z.number().int()).default([]),
      },
    },
    async ({ project, title, requirement, page_ids }) =>
      runSafe(() => createFeature(getProject(project).id, title, requirement, page_ids)),
  );

  server.registerTool(
    "feature_update",
    {
      description: "Update a feature's title, requirement or page list (e.g. when the business rule changes).",
      inputSchema: {
        feature_id: z.number().int(),
        title: z.string().optional(),
        requirement: z.string().optional(),
        page_ids: z.array(z.number().int()).optional(),
      },
    },
    async ({ feature_id, ...patch }) => runSafe(() => updateFeature(feature_id, patch)),
  );

  server.registerTool(
    "feature_get",
    {
      description: "Get a feature with its test cases, review summary and runs.",
      inputSchema: { feature_id: z.number().int() },
    },
    async ({ feature_id }) =>
      runSafe(() => {
        const feature = getFeature(feature_id);
        return {
          feature,
          review: reviewSummary(feature_id),
          cases: listCases(feature_id),
          runs: listRuns(feature.project_id, feature_id),
        };
      }),
  );

  server.registerTool(
    "cases_create",
    {
      description: "Add test cases to a feature. Codes (TC-001...) are assigned automatically per project. New cases start as pending review.",
      inputSchema: { feature_id: z.number().int(), cases: z.array(z.object(caseShape)).min(1) },
    },
    async ({ feature_id, cases }) => runSafe(() => createCases(feature_id, cases)),
  );

  server.registerTool(
    "case_update",
    {
      description: "Edit a test case's content. Review status is not changed here.",
      inputSchema: {
        case_id: z.number().int(),
        ...Object.fromEntries(Object.entries(caseShape).map(([k, v]) => [k, v.optional()])),
      },
    },
    async ({ case_id, ...patch }) => runSafe(() => updateCase(case_id as number, patch)),
  );

  server.registerTool(
    "case_list",
    {
      description: "List test cases of a feature, optionally filtered by review status.",
      inputSchema: { feature_id: z.number().int(), review_status: z.enum(REVIEW_STATUSES).optional() },
    },
    async ({ feature_id, review_status }) => runSafe(() => listCases(feature_id, review_status)),
  );

  server.registerTool(
    "review_get",
    {
      description:
        "Read the user's review of a feature's test cases. need_rebuttal = rejected with a reason, answer each with case_rebut. review_done = nothing left for the user or the AI.",
      inputSchema: { feature_id: z.number().int() },
    },
    async ({ feature_id }) => runSafe(() => reviewSummary(feature_id)),
  );

  server.registerTool(
    "cases_export",
    {
      description:
        "Export a feature's test cases to an Excel review file in the user's Downloads folder. The user fills 'Đánh giá' (Duyệt / Không duyệt) and 'Lý do', then sends the file path back. AI rebuttals appear in 'Phản biện của AI'.",
      inputSchema: { feature_id: z.number().int() },
    },
    async ({ feature_id }) => runSafe(() => exportCases(feature_id)),
  );

  server.registerTool(
    "cases_import",
    {
      description:
        "Read a reviewed test case Excel file back. Blank 'Đánh giá' = no change; Duyệt = approve (or keep after a rebuttal); Không duyệt = reject with the reason (no reason = drop; after a rebuttal = drop). Any invalid row blocks the write unless allow_partial. Returns changes and the review summary (need_rebuttal).",
      inputSchema: { path: z.string(), dry_run: z.boolean().optional(), allow_partial: z.boolean().optional() },
    },
    async ({ path, ...options }) => runSafe(() => importCases(path, options)),
  );

  server.registerTool(
    "case_rebut",
    {
      description:
        "Answer a rejected case: give a rebuttal (shown in the next cases_export file; the user then picks Duyệt = keep or Không duyệt = drop), or concede=true to drop it when the rejection is right.",
      inputSchema: {
        case_id: z.number().int(),
        rebuttal: z.string().nullable().optional(),
        concede: z.boolean().default(false),
      },
    },
    async ({ case_id, rebuttal, concede }) => runSafe(() => rebutCase(case_id, rebuttal ?? null, concede)),
  );
}
