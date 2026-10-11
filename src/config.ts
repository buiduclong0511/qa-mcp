import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface QaConfig {
  /** Evidence storage limit in GB; the skill warns when usage reaches warnRatio of it. */
  storageLimitGb: number;
  warnRatio: number;
  /** A test group with no run for this many days is suggested for cleanup. */
  staleDays: number;
  thumbnailWidth: number;
  /** Warn when Playwright leftovers (profile, output, npx copies, legacy profiles) exceed this size. */
  playwrightWarnGb: number;
}

const DEFAULT_CONFIG: QaConfig = {
  storageLimitGb: 5,
  warnRatio: 0.9,
  staleDays: 60,
  thumbnailWidth: 1280,
  playwrightWarnGb: 3,
};

export function homeDir(): string {
  return process.env.QA_MCP_HOME || join(homedir(), ".qa-mcp");
}

export const paths = {
  db: () => join(homeDir(), "qa.db"),
  evidence: () => join(homeDir(), "evidence"),
  config: () => join(homeDir(), "config.json"),
};

export function ensureDirs(): void {
  for (const dir of [homeDir(), paths.evidence()]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function readConfig(): QaConfig {
  ensureDirs();
  const file = paths.config();
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(patch: Partial<QaConfig>): QaConfig {
  const next = { ...readConfig(), ...patch };
  writeFileSync(paths.config(), JSON.stringify(next, null, 2));
  return next;
}
