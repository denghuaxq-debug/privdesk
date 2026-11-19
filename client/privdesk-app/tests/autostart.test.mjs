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
  // 无人值守注册函数本身不能依赖 autolaunch(即 Run 键)
  const registerFn = rust.slice(
    rust.indexOf("fn register_unattended_task"),
    rust.indexOf("fn unregister_unattended_task"),
  );
  assert.doesNotMatch(registerFn, /autolaunch/);
  // set_autostart 的 Windows 分支也必须是计划任务, autolaunch 只出现在非 Windows 分支
  const setFn = rust.slice(rust.indexOf("fn set_autostart"), rust.indexOf("fn read_profile_params"));
  assert.match(setFn, /#\[cfg\(not\(windows\)\)\]/);
  assert.match(setFn, /register_unattended_task/);
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

// "登录自启"与"无人值守"是两件独立的事, 不能共用一个开关:
// 无人值守负责 SYSTEM 计划任务建隧道(登录前), 登录自启只负责登录后把界面拉起来。
test("launch-at-login is a separate command from the unattended tunnel", () => {
  assert.match(rust, /fn set_launch_at_login/);
  assert.match(rust, /fn get_launch_at_login/);
  // 两个命令都要注册到 invoke_handler
  assert.match(rust, /set_launch_at_login,\s*\n\s*get_launch_at_login,/);
  // 登录自启走 autolaunch(Windows 即登录后由资源管理器触发的 Run 键)
  const launchFn = rust.slice(
    rust.indexOf("fn set_launch_at_login"),
    rust.indexOf("fn get_launch_at_login"),
  );
  assert.match(launchFn, /app\.autolaunch\(\)/);
  assert.doesNotMatch(launchFn, /New-ScheduledTaskTrigger/);
  // 无人值守那侧仍然不依赖 Run 键
  const unattendedFn = rust.slice(
    rust.indexOf("fn register_unattended_task"),
    rust.indexOf("fn unregister_unattended_task"),
  );
  assert.match(unattendedFn, /New-ScheduledTaskTrigger -AtStartup/);
  assert.doesNotMatch(unattendedFn, /app\.autolaunch\(\)/);
});

test("the footer has a dedicated launch-at-login switch", () => {
  assert.match(index, /id="cb-launch-at-login"/);
  assert.match(index, /登录自启/);
  // 文案要让用户分清它只管界面
  assert.match(index, /只管界面/);
  assert.match(app, /function initLaunchAtLogin/);
  assert.match(app, /invoke\("set_launch_at_login"/);
  assert.match(app, /invoke\("get_launch_at_login"\)/);
});

// 装新版本会换安装目录, 老 Run 键会指向已经不存在的 exe。
// 启动时如果开关还开着, 就用当前进程路径重写一次, 保证登录后拉起的是新版本。
test("launch-at-login rewrites a stale Run key with the current exe path", () => {
  const setupIdx = rust.indexOf(".setup(|app| {");
  assert.ok(setupIdx > 0, "run() should have a setup hook");
  const setupHead = rust.slice(setupIdx, setupIdx + 900);
  assert.match(setupHead, /app\.autolaunch\(\)\.is_enabled\(\)/);
  assert.match(setupHead, /app\.autolaunch\(\)\.enable\(\)/);
  assert.match(setupHead, /#\[cfg\(windows\)\]/);
  // 自愈只能发生在 setup 里, 不能混进无人值守的注册/注销逻辑
  assert.doesNotMatch(setupHead, /New-ScheduledTaskPrincipal/);
});
