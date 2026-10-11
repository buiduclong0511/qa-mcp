import { getDb, now, parseJson } from "../db/index.js";

export interface Project {
  id: number;
  slug: string;
  name: string;
  base_url: string;
  environment: string | null;
  login_note: string | null;
  overview: string | null;
  capture_pass_screenshot: number;
  created_at: string;
  updated_at: string;
}

export interface Policy {
  project_id: number;
  can_read: number;
  can_create: number;
  can_update: number;
  can_delete: number;
  can_send_notifications: number;
  can_payment: number;
  test_data_rule: string | null;
  forbidden_areas: string | null;
  notes: string | null;
  confirmed_at: string | null;
  updated_at: string;
}

export interface Page {
  id: number;
  project_id: number;
  name: string;
  url: string | null;
  summary: string | null;
  roles: string[];
  related_page_ids: number[];
  created_at: string;
  updated_at: string;
}

export class NotFoundError extends Error {}
export class InvalidInputError extends Error {}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function logHistory(
  projectId: number,
  entity: string,
  entityId: number | null,
  action: string,
  before: unknown,
  after: unknown,
): void {
  getDb()
    .prepare(
      `INSERT INTO history (project_id, entity, entity_id, action, before, after, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      entity,
      entityId,
      action,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      now(),
    );
}

export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "project";
}

/** Accepts a numeric id or a slug. */
export function getProject(ref: string | number): Project {
  const db = getDb();
  const asNumber = typeof ref === "number" ? ref : /^\d+$/.test(ref) ? Number(ref) : null;
  const row = (asNumber != null
    ? db.prepare("SELECT * FROM projects WHERE id = ?").get(asNumber)
    : db.prepare("SELECT * FROM projects WHERE slug = ?").get(ref)) as Project | undefined;
  if (!row) throw new NotFoundError(`Project not found: ${ref}`);
  return row;
}

export function listProjects(): Array<Project & { feature_count: number; last_run_at: string | null }> {
  return getDb()
    .prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM features f WHERE f.project_id = p.id) AS feature_count,
         (SELECT MAX(r.started_at) FROM runs r WHERE r.project_id = p.id) AS last_run_at
       FROM projects p ORDER BY p.updated_at DESC`,
    )
    .all() as Array<Project & { feature_count: number; last_run_at: string | null }>;
}

export interface ProjectInput {
  slug?: string;
  name: string;
  base_url: string;
  environment?: string | null;
  login_note?: string | null;
  overview?: string | null;
  capture_pass_screenshot?: boolean;
}

export function upsertProject(input: ProjectInput): Project {
  const db = getDb();
  const slug = input.slug ? slugify(input.slug) : slugify(input.name);
  const existing = db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug) as Project | undefined;
  // Same slug derived from the name but a different site: refuse instead of merging two projects.
  if (existing && !input.slug && originOf(existing.base_url) !== originOf(input.base_url)) {
    throw new InvalidInputError(
      `Slug "${slug}" đã dùng cho ${existing.base_url}. Truyền slug khác cho ${input.base_url}, hoặc truyền slug "${slug}" nếu muốn đổi URL của dự án cũ.`,
    );
  }
  const ts = now();
  if (!existing) {
    const info = db
      .prepare(
        `INSERT INTO projects (slug, name, base_url, environment, login_note, overview, capture_pass_screenshot, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        slug,
        input.name,
        input.base_url,
        input.environment ?? null,
        input.login_note ?? null,
        input.overview ?? null,
        input.capture_pass_screenshot === false ? 0 : 1,
        ts,
        ts,
      );
    const created = getProject(Number(info.lastInsertRowid));
    logHistory(created.id, "project", created.id, "create", null, created);
    return created;
  }
  const next = {
    name: input.name,
    base_url: input.base_url,
    environment: input.environment !== undefined ? input.environment : existing.environment,
    login_note: input.login_note !== undefined ? input.login_note : existing.login_note,
    overview: input.overview !== undefined ? input.overview : existing.overview,
    capture_pass_screenshot:
      input.capture_pass_screenshot === undefined
        ? existing.capture_pass_screenshot
        : input.capture_pass_screenshot
          ? 1
          : 0,
  };
  db.prepare(
    `UPDATE projects SET name = ?, base_url = ?, environment = ?, login_note = ?, overview = ?,
       capture_pass_screenshot = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.name,
    next.base_url,
    next.environment,
    next.login_note,
    next.overview,
    next.capture_pass_screenshot,
    ts,
    existing.id,
  );
  const updated = getProject(existing.id);
  logHistory(existing.id, "project", existing.id, "update", existing, updated);
  return updated;
}

export function getPolicy(projectId: number): Policy | null {
  return (getDb().prepare("SELECT * FROM project_policies WHERE project_id = ?").get(projectId) as
    | Policy
    | undefined) ?? null;
}

export interface PolicyInput {
  can_read?: boolean;
  can_create?: boolean;
  can_update?: boolean;
  can_delete?: boolean;
  can_send_notifications?: boolean;
  can_payment?: boolean;
  test_data_rule?: string | null;
  forbidden_areas?: string | null;
  notes?: string | null;
  confirmed_by_user: boolean;
}

export function setPolicy(projectId: number, input: PolicyInput): Policy {
  const db = getDb();
  const before = getPolicy(projectId);
  const flag = (value: boolean | undefined, prev: number | undefined, fallback: number) =>
    value === undefined ? (prev ?? fallback) : value ? 1 : 0;
  const text = (value: string | null | undefined, prev: string | null | undefined) =>
    value === undefined ? (prev ?? null) : value;
  const ts = now();
  const row = {
    can_read: flag(input.can_read, before?.can_read, 1),
    can_create: flag(input.can_create, before?.can_create, 0),
    can_update: flag(input.can_update, before?.can_update, 0),
    can_delete: flag(input.can_delete, before?.can_delete, 0),
    can_send_notifications: flag(input.can_send_notifications, before?.can_send_notifications, 0),
    can_payment: flag(input.can_payment, before?.can_payment, 0),
    test_data_rule: text(input.test_data_rule, before?.test_data_rule),
    forbidden_areas: text(input.forbidden_areas, before?.forbidden_areas),
    notes: text(input.notes, before?.notes),
    confirmed_at: input.confirmed_by_user ? ts : (before?.confirmed_at ?? null),
  };
  db.prepare(
    `INSERT INTO project_policies (project_id, can_read, can_create, can_update, can_delete,
       can_send_notifications, can_payment, test_data_rule, forbidden_areas, notes, confirmed_at, updated_at)
     VALUES (@project_id, @can_read, @can_create, @can_update, @can_delete, @can_send_notifications,
       @can_payment, @test_data_rule, @forbidden_areas, @notes, @confirmed_at, @updated_at)
     ON CONFLICT(project_id) DO UPDATE SET
       can_read = excluded.can_read, can_create = excluded.can_create, can_update = excluded.can_update,
       can_delete = excluded.can_delete, can_send_notifications = excluded.can_send_notifications,
       can_payment = excluded.can_payment, test_data_rule = excluded.test_data_rule,
       forbidden_areas = excluded.forbidden_areas, notes = excluded.notes,
       confirmed_at = excluded.confirmed_at, updated_at = excluded.updated_at`,
  ).run({ project_id: projectId, ...row, updated_at: ts });
  const after = getPolicy(projectId)!;
  logHistory(projectId, "policy", projectId, before ? "update" : "create", before, after);
  return after;
}

function mapPage(row: Record<string, unknown>): Page {
  return {
    ...(row as unknown as Page),
    roles: parseJson<string[]>(row.roles, []),
    related_page_ids: parseJson<number[]>(row.related_page_ids, []),
  };
}

export function listPages(projectId: number): Page[] {
  return (getDb().prepare("SELECT * FROM pages WHERE project_id = ? ORDER BY name").all(projectId) as Array<
    Record<string, unknown>
  >).map(mapPage);
}

export function getPage(pageId: number): Page {
  const row = getDb().prepare("SELECT * FROM pages WHERE id = ?").get(pageId) as Record<string, unknown> | undefined;
  if (!row) throw new NotFoundError(`Page not found: ${pageId}`);
  return mapPage(row);
}

export interface PageInput {
  name: string;
  url?: string | null;
  summary?: string | null;
  roles?: string[];
  /** Related pages by name; resolved after all pages in the batch are saved. */
  related_pages?: string[];
}

/** Upsert by (project, name). Related pages are referenced by name so one batch can link new pages together. */
export function upsertPages(projectId: number, inputs: PageInput[]): Page[] {
  const db = getDb();
  const tx = db.transaction(() => {
    const ts = now();
    const saved: Page[] = [];
    for (const input of inputs) {
      const existingRow = db
        .prepare("SELECT * FROM pages WHERE project_id = ? AND name = ?")
        .get(projectId, input.name) as Record<string, unknown> | undefined;
      const existing = existingRow ? mapPage(existingRow) : null;
      if (!existing) {
        const info = db
          .prepare(
            `INSERT INTO pages (project_id, name, url, summary, roles, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(projectId, input.name, input.url ?? null, input.summary ?? null, JSON.stringify(input.roles ?? []), ts, ts);
        const created = getPage(Number(info.lastInsertRowid));
        logHistory(projectId, "page", created.id, "create", null, created);
        saved.push(created);
      } else {
        db.prepare("UPDATE pages SET url = ?, summary = ?, roles = ?, updated_at = ? WHERE id = ?").run(
          input.url !== undefined ? input.url : existing.url,
          input.summary !== undefined ? input.summary : existing.summary,
          JSON.stringify(input.roles ?? existing.roles),
          ts,
          existing.id,
        );
        const updated = getPage(existing.id);
        logHistory(projectId, "page", existing.id, "update", existing, updated);
        saved.push(updated);
      }
    }
    const byName = new Map(listPages(projectId).map((p) => [p.name, p.id]));
    inputs.forEach((input, i) => {
      if (!input.related_pages) return;
      const ids = input.related_pages.map((name) => {
        const id = byName.get(name);
        if (id == null) throw new NotFoundError(`Related page "${name}" not found in project`);
        return id;
      });
      db.prepare("UPDATE pages SET related_page_ids = ? WHERE id = ?").run(JSON.stringify(ids), saved[i].id);
    });
    return saved.map((p) => getPage(p.id));
  });
  return tx();
}

export function listHistory(projectId: number, limit = 20): unknown[] {
  return (getDb()
    .prepare("SELECT id, entity, entity_id, action, at FROM history WHERE project_id = ? ORDER BY id DESC LIMIT ?")
    .all(projectId, limit) as unknown[]);
}
