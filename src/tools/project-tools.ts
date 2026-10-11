import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listFeatures } from "../repo/cases.js";
import {
  getPolicy,
  getProject,
  listHistory,
  listPages,
  listProjects,
  setPolicy,
  upsertPages,
  upsertProject,
} from "../repo/projects.js";
import { listRuns } from "../repo/runs.js";
import { storageCheck } from "../storage.js";
import { runSafe } from "./_shared.js";

const projectRef = z.union([z.string(), z.number()]).describe("Project slug or numeric id");

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    "storage_check",
    {
      description:
        "Measure evidence (screenshots/logs) disk usage. Call at the start of every QA session. When `warn` is true, show the user the `groups` list (suggested ones first) and ask which to clean with evidence_cleanup.",
      inputSchema: {
        include_groups: z.boolean().optional().describe("Return cleanup groups even when below the warning threshold"),
      },
    },
    async ({ include_groups }) => runSafe(() => storageCheck(include_groups ?? false)),
  );

  server.registerTool(
    "project_list",
    { description: "List saved QA projects with feature count and last run date.", inputSchema: {} },
    async () =>
      runSafe(() =>
        listProjects().map((p) => ({
          id: p.id,
          slug: p.slug,
          name: p.name,
          base_url: p.base_url,
          environment: p.environment,
          feature_count: p.feature_count,
          last_run_at: p.last_run_at,
          updated_at: p.updated_at,
        })),
      ),
  );

  server.registerTool(
    "project_get",
    {
      description:
        "Get everything known about a project: overview, data policy (what the AI may do with the site's data), pages, features, recent runs and recent change history. Always read the policy before testing.",
      inputSchema: { project: projectRef },
    },
    async ({ project }) =>
      runSafe(() => {
        const p = getProject(project);
        return {
          project: p,
          policy: getPolicy(p.id),
          pages: listPages(p.id),
          features: listFeatures(p.id).map((f) => ({ id: f.id, title: f.title, case_count: f.case_count, run_count: f.run_count })),
          recent_runs: listRuns(p.id).slice(0, 10),
          recent_history: listHistory(p.id, 15),
        };
      }),
  );

  server.registerTool(
    "project_upsert",
    {
      description:
        "Create or update a project (matched by slug; slug defaults to a slugified name). Never store passwords: login_note only describes how to log in (which role/account type).",
      inputSchema: {
        slug: z.string().optional(),
        name: z.string(),
        base_url: z.string().url(),
        environment: z.string().nullable().optional().describe("e.g. staging, production"),
        login_note: z.string().nullable().optional(),
        overview: z.string().nullable().optional().describe("Short business overview confirmed by the user (markdown)"),
        capture_pass_screenshot: z.boolean().optional().describe("Take a final screenshot for passed cases (default true)"),
      },
    },
    async (input) => runSafe(() => upsertProject(input)),
  );

  server.registerTool(
    "policy_set",
    {
      description:
        "Save the data policy the user granted for a project. Only call with confirmed_by_user=true after the user explicitly answered. Omitted fields keep their previous value.",
      inputSchema: {
        project: projectRef,
        can_read: z.boolean().optional(),
        can_create: z.boolean().optional(),
        can_update: z.boolean().optional(),
        can_delete: z.boolean().optional(),
        can_send_notifications: z.boolean().optional().describe("Actions that send email/SMS/notifications to real people"),
        can_payment: z.boolean().optional().describe("Actions that charge money or create payments"),
        test_data_rule: z.string().nullable().optional().describe('e.g. "only touch records prefixed with [QA]"'),
        forbidden_areas: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        confirmed_by_user: z.boolean(),
      },
    },
    async ({ project, ...input }) => runSafe(() => setPolicy(getProject(project).id, input)),
  );

  server.registerTool(
    "pages_upsert",
    {
      description:
        "Create or update pages of a project (matched by name). related_pages lists other page names that may be affected by changes on this page; names may refer to pages in the same batch.",
      inputSchema: {
        project: projectRef,
        pages: z
          .array(
            z.object({
              name: z.string(),
              url: z.string().nullable().optional(),
              summary: z.string().nullable().optional(),
              roles: z.array(z.string()).optional(),
              related_pages: z.array(z.string()).optional(),
            }),
          )
          .min(1),
      },
    },
    async ({ project, pages }) => runSafe(() => upsertPages(getProject(project).id, pages)),
  );
}
