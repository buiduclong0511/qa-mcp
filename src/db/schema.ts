import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 3;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      environment TEXT,
      login_note TEXT,
      overview TEXT,
      capture_pass_screenshot INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE project_policies (
      project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      can_read INTEGER NOT NULL DEFAULT 1,
      can_create INTEGER NOT NULL DEFAULT 0,
      can_update INTEGER NOT NULL DEFAULT 0,
      can_delete INTEGER NOT NULL DEFAULT 0,
      can_send_notifications INTEGER NOT NULL DEFAULT 0,
      can_payment INTEGER NOT NULL DEFAULT 0,
      test_data_rule TEXT,
      forbidden_areas TEXT,
      notes TEXT,
      confirmed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE pages (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      url TEXT,
      summary TEXT,
      roles TEXT NOT NULL DEFAULT '[]',
      related_page_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, name)
    );

    CREATE TABLE features (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      requirement TEXT NOT NULL,
      page_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE test_cases (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      preconditions TEXT,
      steps TEXT NOT NULL DEFAULT '[]',
      expected TEXT NOT NULL,
      test_data TEXT,
      review_status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      ai_rebuttal TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_id, code)
    );
    CREATE INDEX idx_cases_feature ON test_cases(feature_id);

    CREATE TABLE runs (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      parent_run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      environment TEXT,
      source_excel TEXT,
      note TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE results (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      case_id INTEGER NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      actual TEXT,
      console_errors TEXT,
      bug_ref TEXT,
      dev_status TEXT NOT NULL DEFAULT 'none',
      dev_note TEXT,
      tested_at TEXT,
      UNIQUE (run_id, case_id)
    );

    CREATE TABLE evidence (
      id INTEGER PRIMARY KEY,
      result_id INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      step_no INTEGER,
      caption TEXT,
      sha256 TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      cleaned_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_evidence_result ON evidence(result_id);

    CREATE TABLE history (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      entity TEXT NOT NULL,
      entity_id INTEGER,
      action TEXT NOT NULL,
      before TEXT,
      after TEXT,
      at TEXT NOT NULL
    );
  `,
  2: `
    CREATE TABLE review_submissions (
      id INTEGER PRIMARY KEY,
      feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      counts TEXT NOT NULL,
      submitted_at TEXT NOT NULL
    );
    CREATE INDEX idx_review_submissions_feature ON review_submissions(feature_id);
  `,
  // Legacy: review_submissions was used by the removed web UI; kept so existing databases stay valid.
  3: `
    ALTER TABLE review_submissions ADD COLUMN kind TEXT NOT NULL DEFAULT 'submit';
  `,
};

export function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v}`);
    })();
  }
}
