import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const index = readFileSync(new URL("src/index.html", root), "utf8");
const app = readFileSync(new URL("src/app.js", root), "utf8");
const rust = readFileSync(new URL("src-tauri/src/lib.rs", root), "utf8");

// 开机自启必须走"登录前"就生效的机制。
// 注册表 Run 键由资源管理器在用户登录后才触发, 停在登录界面时隧道不会建立,
// 所以 Windows 上改用 SYSTEM 身份的 AtStartup 计划任务。
test("Windows unattended mode uses a SYSTEM startup task, not the login-only Run key", () => {
  assert.match(rust, /const UNATTENDED_TASK_NAME: &str = "PrivDesk-Unattended";/);
  assert.match(rust, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(rust, /New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount/);
  assert.match(rust, /-RunLevel Highest/);
  assert.match(rust, /Register-ScheduledTask/);
  // Windows 分支不再依赖 autolaunch(即 Run 键)
  assert.match(rust, /#\[cfg\(not\(windows\)\)\]\s*use tauri_plugin_autostart::ManagerExt;/);
});

test("the unattended task runs frpc with a log file and no stdout capture", () => {
  // 服务化后没有 stdout, 必须让 frpc 自己写日志
  assert.match(rust, /log\.to = /);
  assert.match(rust, /log\.level = \\"info\\"/);
  assert.match(rust, /fn build_unattended_config/);
  // 配置必须无 BOM(带 BOM 时 frpc 会报 toml invalid character)
  assert.match(rust, /无 BOM|no BOM|BOM/);
});

test("unattended state is tracked by a marker file because task querying needs admin", () => {
  // 非管理员 schtasks /query 会被拒绝, 所以用 unattended.json 记录状态
  assert.match(rust, /struct UnattendedState/);
  assert.match(rust, /fn read_unattended_state/);
  assert.match(rust, /fn write_unattended_state/);
  assert.match(rust, /unattended\.json/);
});

test("a running SYSTEM tunnel is detected so the login session does not duplicate it", () => {
  assert.match(rust, /fn unattended_process_running/);
  assert.match(rust, /tasklist/);
  // 通过会话名 Services 或会话号 0 识别 SYSTEM 进程
  assert.match(rust, /Services/);
  assert.match(rust, /fn connect_blocking/);
  assert.match(rust, /已由无人值守隧道保持连接/);
});

test("the autostart switch reports failures instead of silently succeeding", () => {
  // 后端返回 { ok, message }: 注册计划任务需要管理员授权, 可能被取消
  assert.match(rust, /struct AutostartResult/);
  assert.match(rust, /fn set_autostart\(/);
  const handlerStart = app.indexOf('$("cb-autostart").addEventListener("change"');
  assert.ok(handlerStart >= 0, "autostart change handler should exist");
  const handlerEnd = app.indexOf("\n  });", handlerStart);
  const handler = app.slice(handlerStart, handlerEnd);
  // 必须判断 result.ok, 并把 message 反馈给用户
  assert.match(handler, /result\.ok/);
  assert.match(handler, /result\.message/);
  assert.match(handler, /setStatus\("error"/);
  // 开启时需要把连接参数一并传给后端
  assert.match(handler, /params:/);
});

test("the footer explains that unattended mode works without logging in", () => {
  assert.match(index, /id="cb-autostart"/);
  assert.match(index, /无人值守/);
  assert.match(index, /停在登录界面/);
});
