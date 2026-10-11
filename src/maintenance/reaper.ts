import { commandMentions, killTree, listProcesses, processTree, type Proc } from "./processes.js";
import { pwPaths } from "./paths.js";

/**
 * Port of the original playwright-reaper.sh, cross-platform:
 * 1. Playwright browsers alive > maxAge and idle → kill.
 * 2. Playwright browsers whose parent died (orphan) for > orphanGrace → kill.
 * 3. Playwright MCP processes whose parent (the Claude session) died → kill.
 * The personal Chrome is never matched: it does not run from ms-playwright or with our profile dirs.
 */
export interface ReaperOptions {
  maxAgeSec?: number;
  orphanGraceSec?: number;
  sampleMs?: number;
  /** CPU used by the tree during the sample window at or above this means busy. */
  busyCpuMs?: number;
  /** Log decisions without killing anything. */
  dryRun?: boolean;
}

export type Decision = { pid: number; kind: "browser" | "mcp"; action: "kill" | "skip"; reason: string };

// "ms-playwright-mcp" (legacy profile folder) must not count as an MCP process.
const MCP_RE = /@playwright[\\/]mcp|[\\/]\.bin[\\/]playwright-mcp/i;

export function isPlaywrightMcp(p: Proc): boolean {
  return MCP_RE.test(p.command) && !/--type=/.test(p.command);
}

export function isPlaywrightBrowserMain(p: Proc): boolean {
  // The MCP node process also carries --user-data-dir, so it must be excluded first.
  if (/--type=/.test(p.command) || isPlaywrightMcp(p)) return false;
  if (/ms-playwright[\\/]/i.test(p.command) && /chrom|firefox|webkit/i.test(p.command)) return true;
  return (
    /--user-data-dir/.test(p.command) &&
    (commandMentions(p.command, pwPaths.profile()) || commandMentions(p.command, pwPaths.legacyProfiles()))
  );
}

function isOrphan(p: Proc, alive: Set<number>): boolean {
  return p.ppid <= 1 || !alive.has(p.ppid);
}

/** Decisions that need no CPU sampling; browsers that are old but not orphaned come back as "sample". */
export function triage(procs: Proc[], opts: ReaperOptions = {}) {
  const maxAge = opts.maxAgeSec ?? 7200;
  const grace = opts.orphanGraceSec ?? 600;
  const alive = new Set(procs.map((p) => p.pid));
  const decisions: Decision[] = [];
  const toSample: Proc[] = [];
  for (const p of procs) {
    if (isPlaywrightBrowserMain(p)) {
      if (isOrphan(p, alive) && p.ageSec > grace) {
        decisions.push({ pid: p.pid, kind: "browser", action: "kill", reason: `mồ côi, sống ${p.ageSec}s` });
      } else if (p.ageSec > maxAge) {
        toSample.push(p);
      } else {
        decisions.push({ pid: p.pid, kind: "browser", action: "skip", reason: `mới sống ${p.ageSec}s` });
      }
    } else if (isPlaywrightMcp(p)) {
      decisions.push(
        isOrphan(p, alive)
          ? { pid: p.pid, kind: "mcp", action: "kill", reason: "mồ côi (phiên Claude đã tắt)" }
          : { pid: p.pid, kind: "mcp", action: "skip", reason: `cha ${p.ppid} còn sống` },
      );
    }
  }
  return { decisions, toSample };
}

function treeCpu(rootPid: number, procs: Proc[]): number {
  const tree = new Set(processTree(rootPid, procs));
  return procs.filter((p) => tree.has(p.pid)).reduce((sum, p) => sum + p.cpuMs, 0);
}

export async function runReaper(opts: ReaperOptions = {}, log: (line: string) => void = () => {}) {
  const procs = listProcesses();
  const { decisions, toSample } = triage(procs, opts);
  if (toSample.length) {
    await new Promise((ok) => setTimeout(ok, opts.sampleMs ?? 5000));
    const later = listProcesses();
    for (const p of toSample) {
      const delta = treeCpu(p.pid, later) - treeCpu(p.pid, procs);
      decisions.push(
        delta >= (opts.busyCpuMs ?? 500)
          ? { pid: p.pid, kind: "browser", action: "skip", reason: `đang bận (CPU ${delta}ms)` }
          : { pid: p.pid, kind: "browser", action: "kill", reason: `sống ${p.ageSec}s, idle (CPU ${delta}ms)` },
      );
    }
  }
  for (const d of decisions) {
    log(`${d.action === "kill" ? (opts.dryRun ? "WOULD KILL" : "KILL") : "SKIP"} ${d.kind} pid=${d.pid}: ${d.reason}`);
    if (d.action === "kill" && !opts.dryRun) {
      const survivors = await killTree(d.pid, listProcesses());
      if (survivors.length) log(`  KILL -9: ${survivors.join(" ")}`);
    }
  }
  if (decisions.length === 0) log("OK: không có tiến trình Playwright nào");
  return decisions;
}
