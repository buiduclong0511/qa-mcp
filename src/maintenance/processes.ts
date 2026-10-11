import { execFileSync } from "node:child_process";
import { isWindows } from "./paths.js";

export interface Proc {
  pid: number;
  ppid: number;
  ageSec: number;
  /** Total CPU time used so far, in milliseconds. */
  cpuMs: number;
  command: string;
}

/** "[[DD-]HH:]MM:SS[.cc]" (ps etime/time on macOS and Linux) → milliseconds. */
export function parseClock(value: string): number {
  let rest = value.trim();
  let days = 0;
  if (rest.includes("-")) {
    days = Number(rest.slice(0, rest.indexOf("-")));
    rest = rest.slice(rest.indexOf("-") + 1);
  }
  let fraction = 0;
  if (rest.includes(".")) {
    fraction = Number(`0.${rest.slice(rest.indexOf(".") + 1)}`);
    rest = rest.slice(0, rest.indexOf("."));
  }
  const seconds = rest.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return Math.round((days * 86400 + seconds + fraction) * 1000);
}

function listUnix(): Proc[] {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,etime=,time=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      ageSec: Math.round(parseClock(m[3]) / 1000),
      cpuMs: parseClock(m[4]),
      command: m[5],
    });
  }
  return procs;
}

const PS_SCRIPT = [
  "$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()",
  "Get-CimInstance Win32_Process | ForEach-Object {",
  "  $start = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeSeconds() } else { $now }",
  "  $cpu = [math]::Round(($_.KernelModeTime + $_.UserModeTime) / 10000)",
  "  \"{0}`t{1}`t{2}`t{3}`t{4}\" -f $_.ProcessId, $_.ParentProcessId, ($now - $start), $cpu, ($_.CommandLine -replace '[\\r\\n\\t]', ' ')",
  "}",
].join("\n");

function listWindows(): Proc[] {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const procs: Proc[] = [];
  for (const line of out.split(/\r?\n/)) {
    const [pid, ppid, age, cpu, ...cmd] = line.split("\t");
    if (!pid || !/^\d+$/.test(pid)) continue;
    procs.push({ pid: Number(pid), ppid: Number(ppid), ageSec: Number(age), cpuMs: Number(cpu), command: cmd.join("\t") });
  }
  return procs;
}

export function listProcesses(): Proc[] {
  return isWindows ? listWindows() : listUnix();
}

/** The process plus all of its descendants. */
export function processTree(rootPid: number, procs: Proc[]): number[] {
  const children = new Map<number, number[]>();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid)!.push(p.pid);
  }
  const out: number[] = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift()!;
    if (out.includes(pid)) continue;
    out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** TERM the whole tree, wait, then KILL survivors. Windows uses taskkill /T /F. */
export async function killTree(rootPid: number, procs: Proc[]): Promise<number[]> {
  if (isWindows) {
    try {
      execFileSync("taskkill", ["/PID", String(rootPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // already gone
    }
    return [];
  }
  const tree = processTree(rootPid, procs);
  for (const pid of tree) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await new Promise((ok) => setTimeout(ok, 3000));
  const survivors = tree.filter(alive);
  for (const pid of survivors) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return survivors;
}

/** Case-insensitive on Windows, where paths in command lines vary in casing and slashes. */
export function commandMentions(command: string, path: string): boolean {
  if (!isWindows) return command.includes(path);
  const norm = (s: string) => s.toLowerCase().replace(/\//g, "\\");
  return norm(command).includes(norm(path));
}
