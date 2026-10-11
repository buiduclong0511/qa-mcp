#!/usr/bin/env node
// Cài qa-mcp + skill qa-tester + Playwright MCP (cấu hình chống phình RAM/ổ đĩa) + lịch reaper/dọn rác.
// Chạy được trên macOS, Windows, Linux; chạy lại nhiều lần vẫn an toàn.
//
//   node scripts/install.mjs              cài / cập nhật
//   node scripts/install.mjs --uninstall  gỡ lịch chạy, MCP và link skill (giữ dữ liệu ~/.qa-mcp)
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();
const QA_HOME = process.env.QA_MCP_HOME || join(HOME, ".qa-mcp");
const PW_PROFILE = join(QA_HOME, "playwright", "profile");
const PW_OUTPUT = join(QA_HOME, "playwright", "output");
// Browser có cửa sổ mặc định không bao giờ tự đóng; 60 phút không có lệnh nào thì đóng để trả RAM.
const PW_IDLE_MS = process.env.PW_IDLE_MS || "3600000";
const NODE = process.execPath;
const CLI = join(REPO, "dist", "maintenance", "cli.js");
const SKILL_LINK = join(HOME, ".claude", "skills", "qa-tester");
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const uninstall = process.argv.includes("--uninstall");

const step = (msg) => console.log(`\n==> ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);

/** Quote for cmd.exe / sh when a shell is needed (npm, claude are .cmd shims on Windows). */
const q = (arg) => (/[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

function run(cmd, args, { allowFail = false, quiet = false } = {}) {
  const res = isWin
    ? spawnSync([cmd, ...args].map(q).join(" "), { shell: true, stdio: quiet ? "ignore" : "inherit", cwd: REPO })
    : spawnSync(cmd, args, { stdio: quiet ? "ignore" : "inherit", cwd: REPO });
  if (res.status !== 0 && !allowFail) {
    console.error(`Lệnh lỗi: ${cmd} ${args.join(" ")}`);
    process.exit(res.status ?? 1);
  }
  return res.status === 0;
}

function hasCommand(cmd) {
  return isWin
    ? spawnSync("where", [cmd], { stdio: "ignore" }).status === 0
    : spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

const QA_ARGS = [NODE, join(REPO, "dist", "index.js")];
const PW_ARGS = [
  NODE,
  join(REPO, "node_modules", "@playwright", "mcp", "cli.js"),
  "--user-data-dir",
  PW_PROFILE,
  "--output-dir",
  PW_OUTPUT,
  "--idle-timeout",
  PW_IDLE_MS,
];

function registerMcp() {
  step("Đăng ký MCP với Claude Code (scope user)");
  if (!hasCommand("claude")) {
    warn("Không tìm thấy lệnh 'claude'. Cài Claude Code rồi chạy:");
    const envFlag = process.env.QA_MCP_HOME ? `-e QA_MCP_HOME=${q(QA_HOME)} ` : "";
    console.log(`  claude mcp add qa-mcp -s user ${envFlag}-- ${QA_ARGS.map(q).join(" ")}`);
    console.log(`  claude mcp add playwright -s user -- ${PW_ARGS.map(q).join(" ")}`);
    return;
  }
  // qa-mcp must use the same data folder as the Playwright profile/output and the schedules.
  const qaEnv = process.env.QA_MCP_HOME ? ["-e", `QA_MCP_HOME=${QA_HOME}`] : [];
  for (const [name, args, env] of [["qa-mcp", QA_ARGS, qaEnv], ["playwright", PW_ARGS, []]]) {
    run("claude", ["mcp", "remove", name, "-s", "user"], { allowFail: true, quiet: true });
    run("claude", ["mcp", "add", name, "-s", "user", ...env, "--", ...args]);
  }
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function linkSkill() {
  step("Link skill qa-tester");
  mkdirSync(dirname(SKILL_LINK), { recursive: true });
  if (existsSync(SKILL_LINK) || isLink(SKILL_LINK)) {
    if (!isLink(SKILL_LINK)) {
      warn(`${SKILL_LINK} là thư mục thật, không phải link. Bỏ qua, hãy tự xoá rồi chạy lại.`);
      return;
    }
    rmSync(SKILL_LINK, { force: true });
  }
  // Junction needs no admin rights on Windows.
  symlinkSync(join(REPO, "skill", "qa-tester"), SKILL_LINK, isWin ? "junction" : "dir");
}

const TASKS = [
  { id: "reaper", label: "local.playwright-reaper", winName: "qa-mcp-playwright-reaper", args: [CLI, "reaper"] },
  { id: "cleanup", label: "local.qa-mcp-cleanup", winName: "qa-mcp-cleanup", args: [CLI, "cleanup"] },
];

function plist(task) {
  const schedule =
    task.id === "reaper"
      ? "\t<key>StartInterval</key>\n\t<integer>1800</integer>"
      : "\t<key>StartCalendarInterval</key>\n\t<dict>\n\t\t<key>Hour</key>\n\t\t<integer>12</integer>\n\t\t<key>Minute</key>\n\t\t<integer>30</integer>\n\t</dict>";
  const args = [NODE, ...task.args].map((a) => `\t\t<string>${a}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${task.label}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>QA_MCP_HOME</key>
\t\t<string>${QA_HOME}</string>
\t\t<key>PATH</key>
\t\t<string>${dirname(NODE)}:/usr/bin:/bin:/usr/sbin:/sbin</string>
\t</dict>
${schedule}
\t<key>RunAtLoad</key>
\t<false/>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>LowPriorityIO</key>
\t<true/>
\t<key>StandardErrorPath</key>
\t<string>${join(QA_HOME, "logs", `${task.id}.err`)}</string>
</dict>
</plist>
`;
}

function scheduleMac() {
  const agents = join(HOME, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  const uid = String(process.getuid());
  for (const task of TASKS) {
    const file = join(agents, `${task.label}.plist`);
    run("launchctl", ["bootout", `gui/${uid}/${task.label}`], { allowFail: true, quiet: true });
    if (uninstall) {
      rmSync(file, { force: true });
      continue;
    }
    if (existsSync(file)) copyFileSync(file, `${file}.bak`);
    writeFileSync(file, plist(task));
    run("launchctl", ["bootstrap", `gui/${uid}`, file]);
  }
}

function scheduleWindows() {
  const binDir = join(QA_HOME, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const task of TASKS) {
    run("schtasks", ["/Delete", "/F", "/TN", task.winName], { allowFail: true, quiet: true });
    if (uninstall) continue;
    // wscript runs node without flashing a console window every 30 minutes.
    const vbs = join(binDir, `${task.id}.vbs`);
    const cmdLine = [NODE, ...task.args].map((a) => `""${a}""`).join(" ");
    writeFileSync(
      vbs,
      `Set sh = CreateObject("WScript.Shell")\r\nsh.Environment("Process")("QA_MCP_HOME") = "${QA_HOME}"\r\nsh.Run "${cmdLine}", 0, False\r\n`,
    );
    const when = task.id === "reaper" ? ["/SC", "MINUTE", "/MO", "30"] : ["/SC", "DAILY", "/ST", "12:30"];
    run("schtasks", ["/Create", "/F", "/TN", task.winName, ...when, "/TR", `wscript.exe "${vbs}"`]);
  }
}

function schedule() {
  step(uninstall ? "Gỡ lịch reaper / dọn rác" : "Cài lịch reaper (30 phút/lần) và dọn rác (12:30 mỗi ngày)");
  mkdirSync(join(QA_HOME, "logs"), { recursive: true });
  if (isMac) scheduleMac();
  else if (isWin) scheduleWindows();
  else {
    warn(uninstall ? "Xoá 2 dòng qa-mcp khỏi 'crontab -e'." : "Linux: thêm 2 dòng sau vào 'crontab -e':");
    if (!uninstall) {
      console.log(`  */30 * * * * QA_MCP_HOME=${q(QA_HOME)} ${q(NODE)} ${q(CLI)} reaper`);
      console.log(`  30 12 * * * QA_MCP_HOME=${q(QA_HOME)} ${q(NODE)} ${q(CLI)} cleanup`);
    }
  }
}

if (uninstall) {
  schedule();
  if (hasCommand("claude")) {
    step("Gỡ MCP qa-mcp (giữ nguyên MCP playwright)");
    run("claude", ["mcp", "remove", "qa-mcp", "-s", "user"], { allowFail: true });
  }
  if (isLink(SKILL_LINK)) rmSync(SKILL_LINK, { force: true });
  console.log(`\nĐã gỡ. Dữ liệu vẫn ở ${QA_HOME}.`);
  process.exit(0);
}

step("Kiểm tra Node.js >= 20");
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`Node ${process.versions.node} quá cũ, cần >= 20.`);
  process.exit(1);
}

step("Cài dependency và build");
run("npm", ["ci", "--no-audit", "--no-fund"]);
run("npm", ["run", "build"]);

step(`Tạo thư mục dữ liệu ${QA_HOME}`);
for (const dir of ["evidence", "logs", join("playwright", "profile"), join("playwright", "output")]) {
  mkdirSync(join(QA_HOME, dir), { recursive: true });
}

registerMcp();
linkSkill();
schedule();

step("Xong");
console.log("  Khởi động lại Claude Code để nạp MCP và skill.");
console.log(`  Dọn tay: ${q(NODE)} ${q(CLI)} cleanup --dry-run`);
console.log("  Nâng cấp Node (đổi đường dẫn node) thì chạy lại script này.");
