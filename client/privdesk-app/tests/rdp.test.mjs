import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const index = readFileSync(new URL("src/index.html", root), "utf8");
const app = readFileSync(new URL("src/app.js", root), "utf8");
const rust = readFileSync(new URL("src-tauri/src/lib.rs", root), "utf8");

test("Windows RDP capability detection exposes edition and wrapper states", () => {
  assert.match(index, /id="rdp-capability"/);
  assert.match(index, /id="rdp-edition"/);
  assert.match(index, /id="rdp-wrapper-installed"/);
  assert.match(index, /id="rdp-wrapper-listening"/);
  assert.match(index, /id="rdp-wrapper-supported"/);
  assert.match(index, /id="rdp-recommendation"/);
  assert.match(app, /invoke\("check_rdp_status"\)/);
  assert.match(app, /PrivDesk 自带远程|WireGuard/);
  assert.match(rust, /struct RdpStatus/);
  assert.match(rust, /check_rdp_status/);
  assert.match(rust, /ProductName/);
  assert.match(rust, /rdpwrap\.ini/);
});

test("Windows 11 is identified from the build number instead of ProductName", () => {
  assert.match(rust, /DisplayVersion/);
  assert.match(rust, /CurrentBuild/);
  assert.match(rust, /22000/);
  assert.match(rust, /format_windows_edition/);
  assert.match(rust, /Windows 11/);
});

test("Home editions do not run the native RDP enable command automatically", () => {
  const handlerStart = app.indexOf("async function onEnableRdp()");
  assert.ok(handlerStart >= 0, "onEnableRdp should exist");
  const handlerEnd = app.indexOf("// 启动时加载本地缓存的连接信息", handlerStart);
  const handler = app.slice(handlerStart, handlerEnd);
  assert.match(handler, /native_supported/);
  assert.match(handler, /rdp-recommendation/);
  assert.match(handler, /return/);
});

test("RDP capability is refreshed after a user action, not by installing unknown tools", () => {
  assert.match(app, /await checkRdp\(\)/);
  assert.doesNotMatch(rust, /F:\\RDP/);
  assert.doesNotMatch(rust, /RDPWInst\.exe.*-i/);
});

test("Capability panel only shows when the system does not natively support RDP", () => {
  // 展示条件只有 "原生不支持远程桌面"(家庭版等); 专业版即使有 Wrapper 残留文件也不展示,
  // 避免在原生可用的机器上提示安装第三方组件。
  const renderStart = app.indexOf("function renderRdpCapability(");
  assert.ok(renderStart >= 0, "renderRdpCapability should exist");
  const renderEnd = app.indexOf("async function checkRdp()", renderStart);
  const renderer = app.slice(renderStart, renderEnd);
  assert.match(renderer, /wrapper_installed/);
  assert.match(renderer, /showCapability/);
  assert.match(renderer, /classList\.toggle\("hidden"/);
  // 展示条件不得再包含 wrapper_installed / wrapperFilesPresent
  assert.match(renderer, /const showCapability = !nativeSupported;/);
  assert.doesNotMatch(
    renderer,
    /const showCapability = !nativeSupported \|\| wrapper/,
  );
});

test("Source detection reads ini and only lets RDP Wrapper mean installed when it is installed", () => {
  // 文件存在 != 已安装生效: 必须同时校验服务 / IFEO 注入 / System32 dll,
  // 否则"扔了两个文件却从未安装"的机器会被误报成已安装。
  assert.match(rust, /fn rdp_wrapper_files_present\(\) -> bool/);
  assert.match(rust, /fn rdp_wrapper_service_registered\(\) -> bool/);
  assert.match(rust, /fn rdp_wrapper_ifeo_injected\(\) -> bool/);
  assert.match(rust, /fn rdp_wrapper_system32_dll\(\) -> bool/);
  assert.match(rust, /wrapper_files_present: bool/);
  assert.match(rust, /Image File Execution Options/);
  assert.match(rust, /System32/);
  // 残留文件时界面要给出"仅残留文件", 而不是"已安装"
  assert.match(app, /wrapper_files_present/);
  assert.match(app, /仅残留文件/);
});

test("RDP readiness keeps the three-way check (registry + service + port)", () => {
  assert.match(rust, /registry_ok/);
  assert.match(rust, /service_running/);
  assert.match(rust, /port_listening/);
  assert.match(rust, /fDenyTSConnections/);
  assert.match(rust, /TermService/);
  assert.match(rust, /3389/);
});
