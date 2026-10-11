import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { homeDir } from "../config.js";

export const isWindows = process.platform === "win32";

/** OS cache root used by Playwright: ~/Library/Caches, %LOCALAPPDATA%, or ~/.cache. */
export function cacheBase(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches");
  if (isWindows) return process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
}

export const pwPaths = {
  profile: () => join(homeDir(), "playwright", "profile"),
  output: () => join(homeDir(), "playwright", "output"),
  logs: () => join(homeDir(), "logs"),
  browsers: () => process.env.PLAYWRIGHT_BROWSERS_PATH || join(cacheBase(), "ms-playwright"),
  /** Per-workspace profiles created by the default Playwright MCP config. */
  legacyProfiles: () => process.env.QA_PW_LEGACY_DIR || join(cacheBase(), "ms-playwright-mcp"),
  tmp: () => process.env.QA_TMP_DIR || tmpdir(),
  npx: () => process.env.QA_NPX_DIR || join(npmCacheDir(), "_npx"),
};

function npmCacheDir(): string {
  try {
    const out = execFileSync(isWindows ? "npm.cmd" : "npm", ["config", "get", "cache"], {
      encoding: "utf8",
      shell: isWindows,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) return out;
  } catch {
    // fall through to the documented defaults
  }
  return isWindows ? join(cacheBase(), "npm-cache") : join(homedir(), ".npm");
}
