import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "qa-mcp-maint-"));
process.env.QA_MCP_HOME = join(home, "qa");
process.env.QA_PW_LEGACY_DIR = join(home, "legacy");
process.env.QA_NPX_DIR = join(home, "npx");
process.env.QA_TMP_DIR = join(home, "tmp");
process.env.PLAYWRIGHT_BROWSERS_PATH = join(home, "browsers");

const { runCleanup } = await import("../dist/maintenance/cleanup.js");
const { triage, isPlaywrightMcp, isPlaywrightBrowserMain } = await import("../dist/maintenance/reaper.js");
const { parseClock } = await import("../dist/maintenance/processes.js");
const { pwPaths } = await import("../dist/maintenance/paths.js");

after(() => rmSync(home, { recursive: true, force: true }));

const DAY = 24 * 3600 * 1000;
function file(path, ageDays = 0, size = 1024) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(size));
  const t = (Date.now() - ageDays * DAY) / 1000;
  utimesSync(path, t, t);
}
function dir(path, ageDays = 0) {
  mkdirSync(path, { recursive: true });
  file(join(path, "x.bin"), ageDays);
  const t = (Date.now() - ageDays * DAY) / 1000;
  utimesSync(path, t, t);
}

describe("cleanup", () => {
  test("removes old output, profile caches, npx copies, old tmp; keeps logins and recent files", () => {
    const out = pwPaths.output();
    file(join(out, "old.yml"), 5);
    file(join(out, "new.yml"), 0);
    const profile = pwPaths.profile();
    dir(join(profile, "Default", "Cache"));
    file(join(profile, "Default", "Cookies"));
    dir(join(pwPaths.npx(), "abc", "node_modules", "@playwright", "mcp"));
    dir(join(pwPaths.npx(), "other", "node_modules", "left-pad"));
    dir(join(pwPaths.tmp(), "playwright_chromiumdev_profile-old"), 3);
    dir(join(pwPaths.tmp(), "playwright-artifacts-new"), 0);
    dir(join(pwPaths.browsers(), "chromium-1200"));
    dir(join(pwPaths.browsers(), "chromium-1247"));
    dir(join(pwPaths.legacyProfiles(), "mcp-chrome-aaa"));

    const dry = runCleanup({ dryRun: true, processes: [] });
    assert.ok(dry.items.every((i) => i.action === "would_delete"));
    assert.ok(existsSync(join(out, "old.yml")), "dry run deletes nothing");

    runCleanup({ processes: [] });
    assert.ok(!existsSync(join(out, "old.yml")));
    assert.ok(existsSync(join(out, "new.yml")));
    assert.ok(!existsSync(join(profile, "Default", "Cache")));
    assert.ok(existsSync(join(profile, "Default", "Cookies")), "login data kept");
    assert.ok(!existsSync(join(pwPaths.npx(), "abc")));
    assert.ok(existsSync(join(pwPaths.npx(), "other")), "unrelated npx cache kept");
    assert.ok(!existsSync(join(pwPaths.tmp(), "playwright_chromiumdev_profile-old")));
    assert.ok(existsSync(join(pwPaths.tmp(), "playwright-artifacts-new")));
    assert.ok(existsSync(join(pwPaths.browsers(), "chromium-1200")), "browsers only pruned on request");
    assert.ok(existsSync(join(pwPaths.legacyProfiles(), "mcp-chrome-aaa")), "legacy profiles only on request");
  });

  test("optional pruning keeps newest browser and skips anything in use", () => {
    dir(join(pwPaths.profile(), "Default", "Cache"));
    const running = [
      { pid: 10, ppid: 1, ageSec: 5, cpuMs: 0, command: `chrome --user-data-dir=${pwPaths.profile()}` },
      { pid: 11, ppid: 1, ageSec: 5, cpuMs: 0, command: `chrome --user-data-dir=${join(pwPaths.legacyProfiles(), "mcp-chrome-aaa")}` },
    ];
    dir(join(pwPaths.legacyProfiles(), "mcp-chrome-bbb"));
    const res = runCleanup({ pruneBrowsers: true, purgeLegacyProfiles: true, processes: running });
    assert.ok(!existsSync(join(pwPaths.browsers(), "chromium-1200")));
    assert.ok(existsSync(join(pwPaths.browsers(), "chromium-1247")));
    assert.ok(existsSync(join(pwPaths.profile(), "Default", "Cache")), "profile in use is not touched");
    assert.ok(existsSync(join(pwPaths.legacyProfiles(), "mcp-chrome-aaa")), "legacy profile in use is kept");
    assert.ok(!existsSync(join(pwPaths.legacyProfiles(), "mcp-chrome-bbb")));
    assert.ok(res.items.some((i) => i.action === "skipped_in_use"));
  });
});

describe("reaper", () => {
  const profile = () => pwPaths.profile();
  const mcpCmd = () =>
    `node /repo/node_modules/@playwright/mcp/cli.js --user-data-dir ${profile()} --output-dir /x --idle-timeout 3600000`;

  test("classifies processes without touching personal Chrome", () => {
    assert.equal(isPlaywrightMcp({ command: mcpCmd() }), true);
    assert.equal(isPlaywrightBrowserMain({ command: mcpCmd() }), false, "MCP node process is not a browser");
    assert.equal(isPlaywrightMcp({ command: "npm exec @playwright/mcp@latest" }), true);
    assert.equal(isPlaywrightBrowserMain({ command: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profile()}` }), true);
    assert.equal(isPlaywrightBrowserMain({ command: `chrome --user-data-dir=${join(pwPaths.legacyProfiles(), "mcp-chrome-1")}` }), true);
    assert.equal(isPlaywrightMcp({ command: `chrome --user-data-dir=${join(pwPaths.legacyProfiles(), "mcp-chrome-1")}` }), false);
    assert.equal(isPlaywrightBrowserMain({ command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }), false);
    assert.equal(isPlaywrightBrowserMain({ command: `chrome --type=renderer --user-data-dir=${profile()}` }), false);
  });

  test("kills orphans, keeps live sessions, samples old browsers", () => {
    const procs = [
      { pid: 100, ppid: 50, ageSec: 99999, cpuMs: 0, command: "claude" },
      { pid: 101, ppid: 100, ageSec: 99999, cpuMs: 0, command: mcpCmd() },
      { pid: 102, ppid: 101, ageSec: 9000, cpuMs: 0, command: `Google Chrome --user-data-dir=${profile()}` },
      { pid: 103, ppid: 101, ageSec: 60, cpuMs: 0, command: `Google Chrome --user-data-dir=${profile()}` },
      { pid: 200, ppid: 1, ageSec: 500, cpuMs: 0, command: mcpCmd() },
      { pid: 300, ppid: 1, ageSec: 1200, cpuMs: 0, command: `Google Chrome --user-data-dir=${profile()}` },
      { pid: 301, ppid: 4242, ageSec: 30, cpuMs: 0, command: `Google Chrome --user-data-dir=${profile()}` },
    ];
    const { decisions, toSample } = triage(procs);
    const by = Object.fromEntries(decisions.map((d) => [d.pid, d.action]));
    assert.equal(by[101], "skip", "MCP with live Claude parent");
    assert.equal(by[200], "kill", "orphan MCP");
    assert.equal(by[300], "kill", "orphan browser past grace");
    assert.equal(by[301], "skip", "orphan browser still in grace period");
    assert.equal(by[103], "skip", "young browser");
    assert.deepEqual(toSample.map((p) => p.pid), [102]);
  });

  test("parses ps clock formats", () => {
    assert.equal(parseClock("01:02"), 62000);
    assert.equal(parseClock("1-02:03:04"), (86400 + 7384) * 1000);
    assert.equal(parseClock("0:01.50"), 1500);
  });
});
