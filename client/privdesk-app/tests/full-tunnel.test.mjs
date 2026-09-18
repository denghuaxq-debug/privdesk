import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const index = readFileSync(new URL("src/index.html", root), "utf8");
const app = readFileSync(new URL("src/app.js", root), "utf8");
const rust = readFileSync(new URL("src-tauri/src/lib.rs", root), "utf8");
const windowsConfig = readFileSync(new URL("src-tauri/tauri.windows.conf.json", root), "utf8");

test("full sharing exposes a WireGuard exit-node panel", () => {
  assert.match(index, /id="role-sharer"/);
  assert.match(index, /id="role-receiver"/);
  assert.match(index, /id="full-tunnel-panel"/);
  assert.match(index, /id="btn-full-tunnel-toggle"/);
  assert.match(index, /id="full-tunnel-client-config"/);
  assert.match(app, /invoke\("start_full_tunnel"/);
  assert.match(app, /invoke\("stop_full_tunnel_cmd"/);
});

test("receiver role can import and activate a generated client config", () => {
  assert.match(index, /id="full-tunnel-receiver-panel"/);
  assert.match(index, /id="full-tunnel-import-config"/);
  assert.match(index, /id="btn-full-tunnel-client-toggle"/);
  assert.match(app, /invoke\("start_full_tunnel_client"/);
  assert.match(rust, /ClientTunnelParams/);
  assert.match(rust, /valid_wireguard_client_config/);
});

test("full sharing uses a UDP FRP tunnel and a default-route client config", () => {
  assert.match(rust, /type = "udp"/);
  assert.match(rust, /AllowedIPs = 0\.0\.0\.0\/0/);
  assert.match(rust, /PersistentKeepalive = 25/);
  assert.match(rust, /New-NetNat/);
});

test("full sharing validates the public UDP port before starting", () => {
  assert.match(app, /全局共享端口应为 1024-65535 之间的数字/);
  assert.match(rust, /FullTunnelParams/);
  assert.match(rust, /\.parse::<u16>\(\)/);
});

test("full sharing configures WireGuard and NAT in one elevated operation with retries", () => {
  assert.match(rust, /run_elevated_full_tunnel_setup/);
  assert.match(rust, /Start-Sleep -Milliseconds 250/);
  assert.match(rust, /for \(\$attempt = 0; \$attempt -lt 20/);
  assert.match(rust, /Start-Process -FilePath \$wg/);
  assert.match(rust, /-Wait -PassThru/);
  assert.match(rust, /\$wgProcess\.ExitCode/);
});

test("WireGuard cleanup skips missing tunnel services without showing an error dialog", () => {
  assert.match(rust, /wireguard_uninstall_if_present/);
  assert.match(rust, /Get-Service -Name/);
  assert.match(rust, /for \(\$attempt = 0; \$attempt -lt 20; \$attempt\+\+\) \{\{ if \(-not \(Get-Service/);
});

test("elevated PowerShell scripts are passed through a temporary file", () => {
  assert.match(rust, /temp_dir\(\)/);
  assert.match(rust, /-File/);
  assert.match(rust, /fn write_powershell_script/);
  assert.match(rust, /0xEF/);
  assert.match(rust, /write_powershell_script\(&script_path/);
});

test("shared network setup finds the WireGuard adapter by its tunnel address", () => {
  assert.match(rust, /Get-NetIPAddress -AddressFamily IPv4 -IPAddress/);
});

test("shared network falls back to ICS when the WinNAT provider is unavailable", () => {
  assert.match(rust, /FullTunnelNetworkMode/);
  assert.match(rust, /MSFT_NetNat/);
  assert.match(rust, /HNetCfg\.HNetShare/);
  assert.match(rust, /EnableSharing\(1\)/);
  assert.match(rust, /build_wireguard_exit_config_for_network\(\s*&server_private/);
  assert.match(rust, /build_wireguard_client_config_for_network\(\s*&client_private/);
  assert.match(rust, /match network_mode \{/);
  assert.match(rust, /run_elevated_full_tunnel_ics_setup\(/);
  assert.match(rust, /let had_ics = app_dir\(app\)\.join\("PrivDeskExit\.ics"\)\.exists\(\)/);
});

test("receiver waits for delayed WireGuard service registration", () => {
  assert.match(rust, /for attempt in 0\.\.20/);
  assert.match(rust, /WireGuard 客户端服务尚未注册/);
  assert.match(rust, /Duration::from_millis\(250\)/);
});

test("receiver keeps its temporary config until service registration finishes", () => {
  const setup = rust.indexOf("let installed = run_elevated_full_tunnel_client_setup");
  const wait = rust.indexOf("let service_registered =", setup);
  const cleanup = rust.indexOf("let _ = fs::remove_file(&config_path);", wait);
  assert.ok(setup >= 0);
  assert.ok(wait >= 0);
  assert.ok(cleanup >= 0);
  assert.ok(wait < cleanup);
});

test("full sharing exposes actionable diagnostics for administrator failures", () => {
  assert.match(index, /id="full-tunnel-diagnostics"/);
  assert.match(index, /id="full-tunnel-diagnostics-text"/);
  assert.match(app, /full-tunnel-diagnostics/);
  assert.match(app, /open_log_dir/);
  assert.match(rust, /diagnostics: Option<String>/);
  assert.match(rust, /full-tunnel\.log/);
  assert.match(rust, /Write-Output \$message/);
  assert.match(rust, /\[\{\{0\}\}\] /);
});

test("elevated setup does not combine RunAs with stream redirection", () => {
  assert.doesNotMatch(rust, /-Verb RunAs -Wait -PassThru -RedirectStandardOutput/);
  assert.match(rust, /\$ErrorActionPreference\s*=\s*'Stop';\s*\$p = Start-Process/);
  assert.match(rust, /\$null -eq \$p/);
  assert.match(rust, /exit 1/);
});

test("elevation host remains interactive for standard users", () => {
  const program = rust.slice(
    rust.indexOf("fn run_elevated_program"),
    rust.indexOf("fn run_elevated_network_script"),
  );
  assert.match(program, /\.args\(\["-NoProfile", "-Command"/);
  assert.match(rust, /"-NonInteractive"\.to_string\(\)/);
});

test("elevated setup records outer PowerShell errors", () => {
  const elevated = rust.slice(
    rust.indexOf("fn run_elevated_program"),
    rust.indexOf("fn powershell_diagnostics_setup"),
  );
  assert.match(elevated, /\.output\(\)/);
  assert.match(elevated, /管理员 PowerShell 外层/);
});

test("elevated setup captures child PowerShell output through a nested process", () => {
  const elevated = rust.slice(
    rust.indexOf("fn run_elevated_network_script"),
    rust.indexOf("fn powershell_diagnostics_setup"),
  );
  assert.match(elevated, /let wrapper_path/);
  assert.doesNotMatch(elevated, /RedirectStandardOutput/);
  assert.match(elevated, /\*>&1/);
  assert.match(elevated, /ForEach-Object/);
  assert.match(elevated, /ToString\(\)/);
  assert.match(elevated, /Out-File/);
  assert.match(elevated, /Out-String -Width 4096/);
  assert.match(elevated, /\$ErrorActionPreference = 'Continue'/);
  assert.match(elevated, /\$child_exit_code/);
  assert.match(elevated, /Wrapper error/);
});

test("Windows bundles the official WireGuard executables", () => {
  assert.match(windowsConfig, /"wireguard\.exe"/);
  assert.match(windowsConfig, /"wg\.exe"/);
  assert.ok(existsSync(new URL("src-tauri/wireguard.exe", root)));
  assert.ok(existsSync(new URL("src-tauri/wg.exe", root)));
  assert.match(windowsConfig, /licenses\/WireGuard-LICENSE\.txt/);
});
