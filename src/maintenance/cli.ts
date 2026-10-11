#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runCleanup } from "./cleanup.js";
import { pwPaths } from "./paths.js";
import { runReaper } from "./reaper.js";

const USAGE = `Cách dùng:
  node dist/maintenance/cli.js cleanup [--dry-run] [--prune-browsers] [--purge-legacy-profiles]
  node dist/maintenance/cli.js reaper [--dry-run]`;

function logger(name: string) {
  mkdirSync(pwPaths.logs(), { recursive: true });
  const file = join(pwPaths.logs(), `${name}.log`);
  return (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    appendFileSync(file, `${stamped}\n`);
    console.log(stamped);
  };
}

async function main() {
  const [command, ...flags] = process.argv.slice(2);
  if (command === "cleanup") {
    const log = logger("cleanup");
    const report = runCleanup({
      dryRun: flags.includes("--dry-run"),
      pruneBrowsers: flags.includes("--prune-browsers"),
      purgeLegacyProfiles: flags.includes("--purge-legacy-profiles"),
    });
    for (const item of report.items) {
      const label = { deleted: "DEL ", would_delete: "DRY ", skipped_in_use: "SKIP" }[item.action];
      log(`${label} ${item.reason}: ${item.path} (${Math.round(item.bytes / 1024 / 1024)} MB)`);
    }
    log(report.dry_run ? `Có thể giải phóng ${report.freed_mb} MB (dry-run, chưa xoá gì)` : `Đã giải phóng ${report.freed_mb} MB`);
    return;
  }
  if (command === "reaper") {
    await runReaper({ dryRun: flags.includes("--dry-run") }, logger("reaper"));
    return;
  }
  console.log(USAGE);
  process.exitCode = command ? 2 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
