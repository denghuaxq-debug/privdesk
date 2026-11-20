import {
  decodeConnectionCode,
  encodeConnectionCode,
  validateConnectionInfo,
} from "./connection-code.js";

// ===== PrivDesk 客户端 - 界面交互逻辑 =====
// 自动适配: 在 Tauri 中调用真实后端; 在浏览器预览中用模拟。

const $ = (id) => document.getElementById(id);

let uptimeTimer = null;
let uptimeSeconds = 0;
let isConnecting = false; // 防止连接中重复点击
let currentRemoteAddr = ""; // 当前远程地址(给"对方怎么连"弹窗用)
let platform = "windows"; // 运行平台: windows / macos / other (启动时探测)
function isMac() { return platform === "macos"; }

// 安全获取 Tauri invoke (运行时再判断, 避免顶层报错)
function getInvoke() {
  if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
    return window.__TAURI__.core.invoke;
  }
  return null;
}
function inTauri() {
  return getInvoke() !== null;
}

// 等 DOM 就绪后再绑定所有事件
window.addEventListener("DOMContentLoaded", async () => {
  await detectPlatform();
  applyPlatformText();
  bindEvents();
});

// 探测运行平台(失败则保持默认 windows)
async function detectPlatform() {
  const invoke = getInvoke();
  if (!invoke) return;
  try {
    const p = await invoke("get_platform");
    if (p) platform = p;
  } catch (e) {
    console.error("get_platform", e);
  }
}

// 根据平台切换界面文案(Mac: 屏幕共享/VNC; Windows: 远程桌面/RDP)
function applyPlatformText() {
  if (!isMac()) return; // 默认就是 Windows 文案, 仅 Mac 需要替换
  document.documentElement.setAttribute("data-os", "mac");

  // RDP 状态区 -> 屏幕共享
  const warn = $("rdp-warn-text");
  if (warn) warn.textContent = "系统屏幕共享未开启,对方将无法连接";
  const ok = $("rdp-ok-text");
  if (ok) ok.textContent = "屏幕共享已开启";
  const enableBtn = $("btn-enable-rdp");
  if (enableBtn) enableBtn.textContent = "去开启";

  // "对方怎么连"弹窗: 切换到 Mac 版块
  toggleHidden("how-win", true);
  toggleHidden("how-mac", false);

  // 被拦截引导弹窗: 切换到 Mac 版块
  toggleHidden("blocked-win", true);
  toggleHidden("blocked-mac", false);
  const bt = $("blocked-title");
  if (bt) bt.textContent = "连接组件被系统拦截";
}

function toggleHidden(id, hidden) {
  const el = $(id);
  if (el) el.classList.toggle("hidden", hidden);
}

function bindEvents() {
  // ---------- 传输协议切换 (TCP / QUIC) ----------
  document.querySelectorAll(".transport-opt").forEach((el) => {
    el.addEventListener("click", () => {
      if (isConnecting) return; // 连接中不允许切换
      setTransport(el.dataset.transport);
    });
  });
  updateTransportHint();

  // ---------- 显示/隐藏密钥 ----------
  $("btn-toggle-token").addEventListener("click", () => {
    const input = $("token");
    const showing = input.type === "password";
    input.type = showing ? "text" : "password";
    // 切换眼睛图标
    $("icon-eye").classList.toggle("hidden", !showing);
    $("icon-eye-slash").classList.toggle("hidden", showing);
  });

  // ---------- 连接码导入 ----------
  $("btn-import").addEventListener("click", () => {
    const code = $("connect-code").value.trim();
    if (!code) {
      markErrorEl($("connect-code"));
      $("connect-code").focus();
      return;
    }
    try {
      const data = decodeConnectionCode(code);
      $("server-addr").value = data.server || "";
      $("server-port").value = data.port || "7000";
      $("token").value = data.token || "";
      $("remote-port").value = data.remote || "7002";
      // 导入成功: 清空连接码输入框 + 状态栏提示
      $("connect-code").value = "";
      clearErrorEl($("connect-code"));
      setStatus("ok", "✓ 连接码导入成功");
      setTimeout(() => setStatus("off", "未连接"), 2000);
    } catch (e) {
      // 格式错误: 红色抖动
      markErrorEl($("connect-code"));
    }
  });

  // 连接码输入/失焦时清除错误
  $("connect-code").addEventListener("input", () => clearErrorEl($("connect-code")));
  $("connect-code").addEventListener("blur", () => clearErrorEl($("connect-code")));

  // ---------- 连接 ----------
  $("btn-connect").addEventListener("click", onConnect);

  // ---------- 断开 ----------
  $("btn-disconnect").addEventListener("click", onDisconnect);

  // ---------- 复制远程地址 ----------
  $("btn-copy").addEventListener("click", () => {
    const addr = $("remote-address").textContent;
    copyText(addr);
  });

  // ---------- 复制用户名 ----------
  $("btn-copy-user").addEventListener("click", () => {
    const name = $("login-username").textContent;
    if (name && !name.startsWith("(")) copyText(name);
  });

  // ---------- 标题栏按钮 ----------
  $("btn-server-settings").addEventListener("click", openServerSettings);
  $("btn-close-server-settings").addEventListener("click", closeServerSettings);
  $("btn-generate-code").addEventListener("click", onGenerateCode);
  $("btn-copy-generated-code").addEventListener("click", () => {
    copyText($("settings-generated-code").value, $("btn-copy-generated-code"));
  });
  $("btn-toggle-settings-token").addEventListener("click", () => {
    const input = $("settings-token");
    const showing = input.type === "password";
    input.type = showing ? "text" : "password";
    $("settings-icon-eye").classList.toggle("hidden", !showing);
    $("settings-icon-eye-slash").classList.toggle("hidden", showing);
  });
  ["settings-server", "settings-port", "settings-token", "settings-remote"].forEach((id) => {
    $(id).addEventListener("input", () => clearError(id));
  });
  $("server-settings-modal").addEventListener("click", (event) => {
    if (event.target === $("server-settings-modal")) closeServerSettings();
  });

  $("btn-min").addEventListener("click", async () => {
    if (inTauri()) {
      try {
        await window.__TAURI__.window.getCurrentWindow().minimize();
      } catch (e) { console.error("minimize", e); }
    }
  });
  $("btn-close").addEventListener("click", async () => {
    if (inTauri()) {
      try {
        const win = window.__TAURI__.window.getCurrentWindow();
        if ($("cb-tray").checked) {
          await win.hide();
        } else {
          await win.close();
        }
      } catch (e) { console.error("close", e); }
    } else {
      window.close();
    }
  });

  // ---------- 帮助 ----------
  $("btn-help").addEventListener("click", () => {
    const last = isMac()
      ? "4. 把生成的远程地址发给对方, 对方用屏幕共享/VNC 连接(地址前加 vnc://)"
      : "4. 把生成的远程地址发给对方, 对方用远程桌面连接";
    alert("PrivDesk 帮助\n\n1. 在服务端运行安装脚本, 获取连接信息\n2. 把连接码粘贴到这里, 或手动填写\n3. 点击\"连接\"即可\n" + last);
  });

  // ---------- 查看日志 (连接失败时引导) ----------
  $("btn-view-log").addEventListener("click", () => {
    const invoke = getInvoke();
    if (invoke) invoke("open_log_dir").catch((e) => console.error("open_log_dir", e));
  });
  $("btn-open-full-tunnel-log").addEventListener("click", () => {
    const invoke = getInvoke();
    if (invoke) invoke("open_log_dir").catch((e) => console.error("open_log_dir", e));
  });

  // ---------- 输入/失焦时自动清除错误标记 ----------
  ["server-addr", "server-port", "token", "remote-port"].forEach((id) => {
    $(id).addEventListener("input", () => clearError(id));
    $(id).addEventListener("blur", () => clearError(id));
  });

  // ---------- 开机自启 ----------
  initAutostart();

  // ---------- 登录自启 ----------
  initLaunchAtLogin();

  // ---------- 加载本地缓存的连接信息 ----------
  loadProfile().then(() => {
    setTimeout(() => { maybeAutoConnect().catch(e => console.error(e)); }, 1000);
  }).catch(e => console.error(e));

  // ---------- 主题 ----------
  initTheme();

  // ---------- 远程桌面检测 ----------
  checkRdp();
  // 每 30 秒复检一次, 实时反映 RDP 开关状态
  setInterval(checkRdp, 30000);
  $("btn-enable-rdp").addEventListener("click", onEnableRdp);

  // ---------- 被拦截引导弹窗关闭 ----------
  $("btn-blocked-close").addEventListener("click", () => {
    $("blocked-modal").classList.add("hidden");
  });

  // ---------- "对方怎么连"弹窗 ----------
  $("btn-how").addEventListener("click", () => {
    const username = $("login-username").textContent;
    if (isMac()) {
      // Mac: 屏幕共享地址带 vnc:// 前缀, 方便 Mac 用户直接"连接服务器"
      const addrMac = $("how-address-mac");
      const userMac = $("how-username-mac");
      if (addrMac) addrMac.textContent = currentRemoteAddr ? ("vnc://" + currentRemoteAddr) : "—";
      if (userMac) userMac.textContent = username || "—";
    } else {
      $("how-address").textContent = currentRemoteAddr || "—";
      $("how-username").textContent = username || "—";
    }
    $("how-modal").classList.remove("hidden");
  });
  $("btn-how-close").addEventListener("click", () => {
    $("how-modal").classList.add("hidden");
  });
  $("btn-how-copy").addEventListener("click", () => {
    const username = $("login-username").textContent;
    let text;
    if (isMac()) {
      text =
        "【远程连接我的电脑(Mac 屏幕共享)】\n" +
        "Mac 用户: 访达 → 前往 → 连接服务器(Command+K), 地址填:\n" +
        "  vnc://" + (currentRemoteAddr || "") + "\n" +
        "Windows 用户: 用 RealVNC Viewer, 地址填:\n" +
        "  " + (currentRemoteAddr || "") + "\n" +
        "用户名: " + (username || "") + "\n" +
        "密码: 我这台 Mac 的开机登录密码";
    } else {
      text =
        "【远程连接我的电脑】\n" +
        "1. 同时按 Win+R, 输入 mstsc 回车\n" +
        "2. 计算机填: " + (currentRemoteAddr || "") + "\n" +
        "3. 用户名填: " + (username || "") + "\n" +
        "4. 密码: 我这台电脑的开机登录密码";
    }
    copyText(text);
    const btn = $("btn-how-copy");
    const old = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(() => (btn.textContent = old), 1500);
  });
  $("cb-autostart").addEventListener("change", async (e) => {
    const invoke = getInvoke();
    if (!invoke) return;
    const wanted = e.target.checked;
    try {
      const result = await invoke("set_autostart", {
        enable: wanted,
        params: wanted ? readConnectionForm() : null,
      });
      // 后端返回 { ok, message }: 注册计划任务需要管理员授权, 可能被取消
      if (!result || !result.ok) {
        e.target.checked = !wanted; // 回滚勾选状态
        setStatus("error", (result && result.message) || "设置开机自启失败");
        return;
      }
      setAutostartHint(wanted, result.message);
    } catch (err) {
      console.error("set_autostart", err);
      e.target.checked = !wanted;
      setStatus("error", "设置开机自启失败");
    }
  });

  // ---------- 登录自启: 登录进桌面后自动打开界面 ----------
  $("cb-launch-at-login").addEventListener("change", async (e) => {
    const invoke = getInvoke();
    if (!invoke) return;
    const wanted = e.target.checked;
    try {
      const result = await invoke("set_launch_at_login", { enable: wanted });
      if (!result || !result.ok) {
        e.target.checked = !wanted;
        setStatus("error", (result && result.message) || "设置登录自启失败");
        return;
      }
      const label = $("lb-launch-at-login");
      if (label) label.title = result.message;
    } catch (err) {
      console.error("set_launch_at_login", err);
      e.target.checked = !wanted;
      setStatus("error", "设置登录自启失败");
    }
  });

  // ---------- 控制端: 模式切换 / 系统选择 / 开始远程 ----------
  initController();
}

// 启动时读取开机自启的真实状态, 同步到复选框
async function initAutostart() {
  const invoke = getInvoke();
  if (invoke) {
    try {
      const enabled = await invoke("get_autostart");
      $("cb-autostart").checked = !!enabled;
      setAutostartHint(!!enabled, "");
    } catch (e) {
      console.error("get_autostart", e);
    }
  }
}

// 启动时读取登录自启的真实状态, 同步到复选框
async function initLaunchAtLogin() {
  const invoke = getInvoke();
  if (!invoke) return;
  try {
    const enabled = await invoke("get_launch_at_login");
    $("cb-launch-at-login").checked = !!enabled;
    const label = $("lb-launch-at-login");
    if (label) {
      label.title = enabled
        ? "已开启: 登录进桌面时自动打开界面"
        : "开启后: 登录进桌面时自动打开这个界面(只管界面, 隧道已由无人值守负责)";
    }
  } catch (e) {
    console.error("get_launch_at_login", e);
  }
}

// 从表单读出一组连接参数(未校验), 供开启无人值守时传给后端
function readConnectionForm() {
  return {
    server: $("server-addr").value.trim(),
    port: $("server-port").value.trim(),
    token: $("token").value.trim(),
    remote: $("remote-port").value.trim(),
    protocol: getTransport(),
  };
}

// 无人值守开关的说明文案: 开启后开机(即使停在登录界面)也能远程连入
function setAutostartHint(enabled, message) {
  const label = $("lb-autostart") || $("cb-autostart");
  if (!label) return;
  label.title =
    message ||
    (enabled
      ? "已开启: 开机会在登录前自动建立隧道, 无需登录即可远程连入"
      : "开启后: 开机即自动建立隧道, 停在登录界面也能远程连入(需一次管理员授权)");
}

// ========== 主题切换 ==========
function initTheme() {
  // 读取保存的主题(默认: 纯黑 + 纯黑主题色)

  const theme = localStorage.getItem("pd-theme") || "black";
  const accent = localStorage.getItem("pd-accent") || "black";
  applyTheme(theme, accent);

  // 主题按钮: 打开/关闭面板
  $("btn-theme").addEventListener("click", (e) => {
    e.stopPropagation();
    $("theme-panel").classList.toggle("hidden");
  });
  // 点击面板外部关闭
  document.addEventListener("click", (e) => {
    const panel = $("theme-panel");
    if (!panel.classList.contains("hidden") &&
        !panel.contains(e.target) &&
        e.target.id !== "btn-theme" &&
        !$("btn-theme").contains(e.target)) {
      panel.classList.add("hidden");
    }
  });

  // 外观模式按钮
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const a = localStorage.getItem("pd-accent") || "black";
      applyTheme(btn.dataset.theme, a);
    });
  });
  // 主题色按钮
  document.querySelectorAll(".color-dot").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = localStorage.getItem("pd-theme") || "black";
      applyTheme(t, btn.dataset.accent);
    });
  });
}

function applyTheme(theme, accent) {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-accent", accent);
  localStorage.setItem("pd-theme", theme);
  localStorage.setItem("pd-accent", accent);
  document.querySelectorAll(".mode-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.theme === theme)
  );
  document.querySelectorAll(".color-dot").forEach((b) =>
    b.classList.toggle("active", b.dataset.accent === accent)
  );
  // 同步更新托盘图标颜色
  updateTrayColor(accent);
}

// 各主题色对应的 RGB(与 CSS 里的 --primary 一致)
const ACCENT_RGB = {
  blue:   [59, 130, 246],
  green:  [16, 185, 129],
  purple: [139, 92, 246],
  orange: [245, 158, 11],
  pink:   [236, 72, 153],
  cyan:   [6, 182, 212],
  dark:   [100, 116, 139],
  black:  [120, 120, 120],
};
function updateTrayColor(accent) {
  const invoke = getInvoke();
  if (!invoke) return;
  const rgb = ACCENT_RGB[accent] || ACCENT_RGB.blue;
  invoke("update_tray_color", { r: rgb[0], g: rgb[1], b: rgb[2] }).catch(() => {});
}

// ========== 远程桌面检测 ==========
let lastRdpState = null; // 记录上次就绪状态, 避免重复操作 DOM
let lastRdpCapability = null; // 最近一次的完整检测结果(含系统版本/RDP Wrapper)

// 渲染「RDP 环境检测」面板。
// 展示条件: 仅当系统原生不支持远程桌面(家庭版 / 精简版等)时才展示, 用来提示安装 RDP Wrapper。
// 专业版原生就支持远程桌面, 即使目录里留着 Wrapper 残留文件也不展示, 避免干扰主流程。
function renderRdpCapability(status) {
  const panel = $("rdp-capability");
  if (!panel) return;
  const nativeSupported = !!status.native_supported;
  const wrapperInstalled = !!status.wrapper_installed;
  const wrapperFilesPresent = !!status.wrapper_files_present;
  const showCapability = !nativeSupported;
  panel.classList.toggle("hidden", !showCapability);
  if (!showCapability) return;

  const wrapperListening = !!status.wrapper_listening;
  const wrapperSupported = !!status.wrapper_supported;
  const wrapperReady = wrapperInstalled && wrapperSupported && wrapperListening;

  const edition = $("rdp-edition");
  if (edition) edition.textContent = status.edition || "未知";
  const installed = $("rdp-wrapper-installed");
  if (installed) {
    // 文件在目录里但没注册服务 / 没注入, 属于残留, 不能报"已安装"
    installed.textContent = wrapperInstalled
      ? "已安装"
      : wrapperFilesPresent
        ? "仅残留文件"
        : "未安装";
  }
  const listening = $("rdp-wrapper-listening");
  if (listening) listening.textContent = wrapperListening ? "正在监听" : "未监听";
  const supported = $("rdp-wrapper-supported");
  if (supported) {
    // 未装 Wrapper 时谈"版本支持"没有意义, 直接显示未安装
    supported.textContent = wrapperInstalled
      ? wrapperSupported
        ? "支持当前版本"
        : "未确认支持"
      : "未安装";
  }

  const recommendation = $("rdp-recommendation");
  if (recommendation) {
    // 能走到这里就说明原生不支持远程桌面(家庭版等), 只有装 RDP Wrapper 这条路
    if (wrapperReady) {
      recommendation.textContent =
        "当前 RDP Wrapper 已确认兼容。优先使用 PrivDesk 自带远程或 WireGuard 内网访问。";
    } else if (wrapperInstalled) {
      recommendation.textContent =
        "RDP Wrapper 已安装但未正常监听, 请确认版本支持并重启远程桌面服务。";
    } else if (wrapperFilesPresent) {
      recommendation.textContent =
        "检测到 RDP Wrapper 残留文件, 但未注册服务或注入, 未生效。需要时才手动安装。";
    } else {
      recommendation.textContent =
        "系统原生不支持远程桌面, 可安装 RDP Wrapper 后使用。建议优先使用 PrivDesk 自带远程或 WireGuard 内网访问。";
    }
  }
}

async function checkRdp() {
  const invoke = getInvoke();
  if (!invoke) return; // 浏览器预览跳过
  try {
    // 优先用三重校验(注册表 + 服务 + 端口), 拿不到再退回旧布尔接口
    let status = null;
    try {
      status = await invoke("check_rdp_status");
    } catch (e) {
      // 老版本后端没有该命令, 忽略
    }

    if (status) {
      lastRdpCapability = status;
      renderRdpCapability(status);
    }

    const ready = status ? !!status.ready : await invoke("check_rdp_enabled");
    // 就绪状态没变化就不重复操作提示条
    if (ready === lastRdpState) return;
    lastRdpState = ready;

    if (ready) {
      $("rdp-status").classList.add("hidden");
      $("rdp-ok").classList.remove("hidden");
      const okText = $("rdp-ok-text");
      if (okText) {
        okText.textContent =
          status && status.message ? status.message : "远程桌面已开启";
      }
    } else {
      $("rdp-ok").classList.add("hidden");
      $("rdp-status").classList.remove("hidden");
      // 具体是哪一环没通过, 直接提示出来, 避免用户反复点"一键开启"
      const warn = $("rdp-warn-text");
      if (warn) {
        warn.textContent =
          (status && status.message) || "系统远程桌面未开启,对方将无法连接";
      }
    }
  } catch (e) {
    console.error("check_rdp", e);
  }
}

async function onEnableRdp() {
  const invoke = getInvoke();
  if (!invoke) return;
  const btn = $("btn-enable-rdp");
  const restoreText = isMac() ? "去开启" : "一键开启";
  // 家庭版没有可用的系统远程桌面, 开 fDenyTSConnections 也不会生效。
  // 不自动下载安装 RDP Wrapper(第三方组件), 只给出建议。
  if (
    !isMac() &&
    lastRdpCapability &&
    !lastRdpCapability.native_supported
  ) {
    const recommendation = $("rdp-recommendation");
    if (recommendation) {
      recommendation.textContent =
        "Windows 家庭版不支持系统远程桌面, 无法通过注册表开启。建议使用 PrivDesk 自带远程或 WireGuard 内网访问。";
    }
    return;
  }
  btn.disabled = true;
  btn.textContent = isMac() ? "打开设置中..." : "开启中...";
  try {
    await invoke("enable_rdp");
    // 等待 UAC 授权 / 用户在设置里勾选 后再重新检测
    setTimeout(async () => {
      await checkRdp();
      btn.disabled = false;
      btn.textContent = restoreText;
    }, 2500);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = restoreText;
  }
}

// 启动时加载本地缓存的连接信息, 自动填充表单
async function loadProfile() {
  const invoke = getInvoke();
  if (!invoke) return;
  try {
    const p = await invoke("load_profile");
    if (p) {
      if (p.server) $("server-addr").value = p.server;
      if (p.port) $("server-port").value = p.port;
      if (p.token) $("token").value = p.token;
      if (p.remote) $("remote-port").value = p.remote;
      // 恢复上次选择的传输协议
      if (p.protocol) setTransport(p.protocol);
    }
  } catch (e) {
    console.error("load_profile", e);
  }
}

// ---------- 传输协议 (TCP / QUIC) ----------
// QUIC 基于 UDP, 在高延迟/抖动的链路上建连更快、抗丢包更好。
// 注意: 服务端需开启 quicBindPort(默认 7001) 并在安全组放行该 UDP 端口。
// 端口号由用户在"连接端口"里自行填写, 切换协议不会自动改端口。
let currentTransport = "tcp";

function getTransport() {
  return currentTransport;
}

function setTransport(proto) {
  currentTransport = proto === "quic" ? "quic" : "tcp";
  document.querySelectorAll(".transport-opt").forEach((el) => {
    const on = el.dataset.transport === currentTransport;
    el.classList.toggle("active", on);
    el.setAttribute("aria-selected", on ? "true" : "false");
  });
  updateTransportHint();
}

function updateTransportHint() {
  const hint = $("transport-hint");
  if (!hint) return;
  if (currentTransport === "quic") {
    hint.textContent = "QUIC 走 UDP, 建连更快、弱网更稳(需服务端开启 QUIC 并放行 UDP 端口)";
    hint.className = "transport-hint hint-quic";
  } else {
    hint.textContent = "TCP 兼容性最好, 任何网络环境都可用";
    hint.className = "transport-hint hint-tcp";
  }
}

// ---------- 服务器设置与连接码生成 ----------
function readMainConnectionInfo() {
  return {
    server: $("server-addr").value.trim(),
    port: $("server-port").value.trim(),
    token: $("token").value.trim(),
    remote: $("remote-port").value.trim(),
  };
}

function setSettingsConnectionInfo(info) {
  $("settings-server").value = info.server || "";
  $("settings-port").value = info.port || "7000";
  $("settings-token").value = info.token || "";
  $("settings-remote").value = info.remote || "7002";
}

function setSettingsStatus(type, text) {
  const status = $("settings-status");
  status.textContent = text;
  status.className = "settings-status";
  if (type) status.classList.add(type);
}

function openServerSettings() {
  setSettingsConnectionInfo(readMainConnectionInfo());
  ["settings-server", "settings-port", "settings-token", "settings-remote"].forEach(clearError);
  $("settings-generated-code").value = "";
  $("settings-code-result").classList.add("hidden");
  setSettingsStatus("", "");
  $("server-settings-modal").classList.remove("hidden");
  $("settings-server").focus();
}

function closeServerSettings() {
  $("server-settings-modal").classList.add("hidden");
}

async function persistConnectionInfo(info) {
  const invoke = getInvoke();
  if (!invoke) return null;
  try {
    return await invoke("save_profile", { params: info });
  } catch (e) {
    return false;
  }
}

async function onGenerateCode() {
  const info = {
    server: $("settings-server").value.trim(),
    port: $("settings-port").value.trim(),
    token: $("settings-token").value.trim(),
    remote: $("settings-remote").value.trim(),
  };
  const validation = validateConnectionInfo(info);
  const fieldIds = {
    server: "settings-server",
    port: "settings-port",
    token: "settings-token",
    remote: "settings-remote",
  };

  Object.values(fieldIds).forEach(clearError);
  if (!validation.ok) {
    for (const [field, message] of Object.entries(validation.errors)) {
      markError(fieldIds[field]);
      setSettingsStatus("error", message);
    }
    const firstInvalid = Object.keys(validation.errors)[0];
    $(fieldIds[firstInvalid]).focus();
    return;
  }

  try {
    const code = encodeConnectionCode(validation.value);
    $("settings-generated-code").value = code;
    $("settings-code-result").classList.remove("hidden");

    // 生成后同步主表单, 用户可直接点击“连接”。
    $("server-addr").value = validation.value.server;
    $("server-port").value = validation.value.port;
    $("token").value = validation.value.token;
    $("remote-port").value = validation.value.remote;

    const saved = await persistConnectionInfo(validation.value);
    setSettingsStatus(
      saved === false ? "error" : "ok",
      saved === false ? "连接码已生成，但设置保存失败" : "✓ 连接码已生成，服务器设置已保存"
    );
  } catch (e) {
    setSettingsStatus("error", "连接码生成失败，请检查输入");
  }
}

// 开机自启场景: 若已开启自启 + 有完整连接信息, 自动连接并最小化到托盘
// 注意: 独立实现, 绝不锁界面(不复用 onConnect 的按钮禁用逻辑)
async function maybeAutoConnect() {
  const invoke = getInvoke();
  if (!invoke) return;
  try {
    const autostart = await invoke("get_autostart");
    if (!autostart) return;
    const server = $("server-addr").value.trim();
    const port = $("server-port").value.trim();
    const token = $("token").value.trim();
    const remote = $("remote-port").value.trim();
    if (!(server && port && token && remote)) return;

    // 后台静默连接, 不动按钮/不锁界面
    setStatus("connecting", "开机自动连接中...");
    invoke("connect", { params: { server, port, token, remote, protocol: getTransport() } })
      .then((result) => {
        if (result && result.ok) {
          showConnected(server, remote);
          // 连上后最小化到托盘
          if (window.__TAURI__ && window.__TAURI__.window) {
            window.__TAURI__.window.getCurrentWindow().hide().catch(() => {});
          }
        } else {
          const msg = result ? result.message : "自动连接失败";
          setStatus("error", msg.replace("BLOCKED:", ""));
        }
      })
      .catch((e) => setStatus("error", "自动连接出错"));
  } catch (e) {
    console.error("auto_connect", e);
  }
}

// ---------- 连接处理 ----------
async function onConnect() {
  // 防重入: 连接中直接忽略再次点击
  if (isConnecting) return;

  const fields = [
    { id: "server-addr", val: $("server-addr").value.trim() },
    { id: "server-port", val: $("server-port").value.trim() },
    { id: "token", val: $("token").value.trim() },
    { id: "remote-port", val: $("remote-port").value.trim() },
  ];

  // 清除之前的错误标记
  fields.forEach((f) => clearError(f.id));

  // 校验: 找出所有空字段, 标红+抖动
  let firstEmpty = null;
  fields.forEach((f) => {
    if (!f.val) {
      markError(f.id);
      if (!firstEmpty) firstEmpty = f.id;
    }
  });
  if (firstEmpty) {
    $(firstEmpty).focus();
    return;
  }

  // 校验地址、端口和密钥, 防止非法内容进入 frpc 配置文件。
  const validation = validateConnectionInfo({
    server: fields[0].val,
    port: fields[1].val,
    token: fields[2].val,
    remote: fields[3].val,
  });
  if (!validation.ok) {
    const fieldIds = { server: fields[0].id, port: fields[1].id, token: fields[2].id, remote: fields[3].id };
    for (const [field, message] of Object.entries(validation.errors)) {
      markError(fieldIds[field]);
      setStatus("error", message);
    }
    $(fieldIds[Object.keys(validation.errors)[0]]).focus();
    return;
  }

  const { server, port, token, remote } = validation.value;
  const protocol = getTransport();

  const btn = $("btn-connect");
  isConnecting = true;
  btn.disabled = true;
  btn.classList.add("btn-disabled");
  btn.textContent = "连接中...";
  setStatus("connecting", "正在连接服务器...");

  try {
    const invoke = getInvoke();
    if (invoke) {
      const result = await invoke("connect", {
        params: { server, port, token, remote, protocol },
      });
      if (result && result.ok) {
        // 连接成功: 保存连接信息到本地(含协议选择)
        try { await invoke("save_profile", { params: { server, port, token, remote, protocol } }); } catch (e) {}
        showConnected(server, remote);
      } else {
        const msg = result ? result.message : "连接失败";
        // 被安全软件拦截 -> 弹引导窗口
        if (msg.startsWith("BLOCKED:")) {
          $("blocked-modal").classList.remove("hidden");
          setStatus("error", msg.replace("BLOCKED:", ""));
        } else {
          setStatus("error", msg);
        }
      }
    } else {
      // 浏览器预览: 延迟模拟成功
      setTimeout(() => showConnected(server, remote), 500);
    }
  } catch (e) {
    setStatus("error", "连接出错: " + e);
  } finally {
    isConnecting = false;
    btn.disabled = false;
    btn.classList.remove("btn-disabled");
    btn.innerHTML = CONNECT_BTN_HTML;
  }
}

// 连接按钮的原始内容(含图标), 用于连接后恢复
const CONNECT_BTN_HTML = '<i class="bi bi-plug-fill btn-icon"></i> 连 接';

// ---------- 设置状态栏显示 ----------
function setStatus(type, text) {
  const dot = $("status-dot");
  const txt = $("status-text");
  if (!dot || !txt) return;
  txt.textContent = text;
  dot.className = "status-dot";
  // 仅在错误状态显示"查看日志"入口, 其他状态隐藏
  const logLink = $("btn-view-log");
  if (logLink) logLink.classList.toggle("hidden", type !== "error");
  if (type === "connecting") {
    dot.classList.add("dot-connecting");
    txt.style.color = "";
  } else if (type === "error") {
    dot.classList.add("dot-off");
    txt.style.color = "var(--danger)";
  } else if (type === "ok") {
    dot.classList.add("dot-on");
    txt.style.color = "var(--success)";
  } else {
    dot.classList.add("dot-off");
    txt.style.color = "";
  }
}

// ---------- 校验视觉: 标红+抖动 ----------
function markError(id) {
  const input = $(id);
  // 密钥字段的输入框被包在 .input-with-icon 里
  const wrapper = input.closest(".input-with-icon");
  const target = wrapper || input;
  target.classList.add("error");
  input.classList.add("error");
  // 触发抖动 (重置动画)
  target.classList.remove("shake");
  void target.offsetWidth; // 强制重绘
  target.classList.add("shake");
}
function clearError(id) {
  const input = $(id);
  const wrapper = input.closest(".input-with-icon");
  if (wrapper) wrapper.classList.remove("error", "shake");
  input.classList.remove("error", "shake");
}

// 通用版: 直接对元素标红抖动(用于连接码输入框)
function markErrorEl(el) {
  el.classList.add("error");
  el.classList.remove("shake");
  void el.offsetWidth;
  el.classList.add("shake");
}
function clearErrorEl(el) {
  el.classList.remove("error", "shake");
}

// ---------- 断开处理 ----------
async function onDisconnect() {
  try {
    const invoke = getInvoke();
    if (invoke) {
      await invoke("disconnect");
    }
  } catch (e) {
    console.error(e);
  }
  showDisconnected();
}

// ---------- 复制文本 ----------
function copyText(text, feedbackButton = $("btn-copy")) {
  const done = () => {
    if (!feedbackButton) return;
    const span = feedbackButton.querySelector("span");
    if (span) {
      const old = span.textContent;
      span.textContent = "已复制";
      setTimeout(() => (span.textContent = old), 1500);
      return;
    }
    const old = feedbackButton.textContent;
    feedbackButton.textContent = "已复制";
    setTimeout(() => (feedbackButton.textContent = old), 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch (e) {}
  document.body.removeChild(ta);
}

// 读取本机 Windows 用户名, 显示在已连接视图里(远程方登录要填)
async function loadUsername() {
  const el = $("login-username");
  if (!el) return;
  const invoke = getInvoke();
  if (!invoke) { el.textContent = "(当前电脑用户名)"; return; }
  try {
    const name = await invoke("get_username");
    el.textContent = name && name.trim() ? name : "(读取失败,见电脑登录名)";
  } catch (e) {
    console.error("get_username", e);
    el.textContent = "(读取失败,见电脑登录名)";
  }
}

// ---------- 视图切换 ----------
function showConnected(server, remotePort) {
  $("view-disconnected").classList.add("hidden");
  $("view-connected").classList.remove("hidden");
  $("remote-address").textContent = `${server}:${remotePort}`;
  $("info-server").textContent = server;
  // 显示本次实际使用的传输协议
  const tp = $("info-transport");
  if (tp) {
    const isQuic = getTransport() === "quic";
    tp.textContent = isQuic ? "QUIC (UDP)" : "TCP";
    tp.style.color = isQuic ? "#10b981" : "";
  }
  currentRemoteAddr = `${server}:${remotePort}`;
  // 显示本机 Windows 用户名, 提示远程方登录时填这个
  loadUsername();
  // 重置未连接视图的状态栏(下次断开回来是干净的)
  setStatus("off", "未连接");
  uptimeSeconds = 0;
  uptimeTimer = setInterval(() => {
    uptimeSeconds++;
    $("uptime").textContent = formatTime(uptimeSeconds);
  }, 1000);
}

function showDisconnected() {
  $("view-connected").classList.add("hidden");
  $("view-disconnected").classList.remove("hidden");
  if (uptimeTimer) clearInterval(uptimeTimer);
  $("uptime").textContent = "00:00:00";
  // 重置底部状态栏为"未连接"
  setStatus("off", "未连接");
}

function formatTime(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

// ============ 控制端(远程别人) ============
let ctrlOs = "mac"; // 当前选择: mac(VNC) / win(RDP)
let isRemoting = false; // 防重复点击

function initController() {
  // ---- 模式切换 ----
  document.querySelectorAll(".mode-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchMode(tab.dataset.mode));
  });

  // ---- 系统选择 (Mac / Windows) ----
  document.querySelectorAll(".os-btn").forEach((btn) => {
    btn.addEventListener("click", () => setCtrlOs(btn.dataset.os));
  });

  // ---- 显示/隐藏密码 ----
  $("ctrl-toggle-pw").addEventListener("click", () => {
    const input = $("ctrl-password");
    const showing = input.type === "password";
    input.type = showing ? "text" : "password";
    $("ctrl-icon-eye").classList.toggle("hidden", !showing);
    $("ctrl-icon-eye-slash").classList.toggle("hidden", showing);
  });

  // ---- 开始远程 ----
  $("btn-remote").addEventListener("click", onRemote);

  // ---- 控制端帮助弹窗 ----
  $("btn-ctrl-help").addEventListener("click", () => {
    $("ctrl-help-modal").classList.remove("hidden");
  });
  $("btn-ctrl-help-close").addEventListener("click", () => {
    $("ctrl-help-modal").classList.add("hidden");
  });

  // ---- 清空历史 ----
  $("btn-clear-history").addEventListener("click", clearHistory);

  // ---- 地址输入时清错误 ----
  $("ctrl-address").addEventListener("input", () => clearError("ctrl-address"));

  // ---- 渲染最近远程记录 ----
  renderHistory();
  applyCtrlOsUi();

  // ---- 初始化 HTTP / 全局共享 ----
  initProxy();
  initFullTunnel();
}

// 切换 被控/控制/HTTP共享/全局共享 四个模式视图
function switchMode(mode) {
  const modes = ["controlled", "controller", "proxy", "full-tunnel"];
  const m = modes.includes(mode) ? mode : "controlled";
  $("mode-controlled").classList.toggle("hidden", m !== "controlled");
  $("mode-controller").classList.toggle("hidden", m !== "controller");
  $("mode-proxy").classList.toggle("hidden", m !== "proxy");
  $("mode-full-tunnel").classList.toggle("hidden", m !== "full-tunnel");
  $("tab-controlled").classList.toggle("active", m === "controlled");
  $("tab-controller").classList.toggle("active", m === "controller");
  $("tab-proxy").classList.toggle("active", m === "proxy");
  $("tab-full-tunnel").classList.toggle("active", m === "full-tunnel");
  // 进入共享页面时刷新一次(检查服务器信息/运行状态)
  if (m === "proxy") refreshProxyView();
  if (m === "full-tunnel") refreshFullTunnelView();
}

// 根据选择的对方系统, 调整密码提示文案
function applyCtrlOsUi() {
  const hint = $("ctrl-pw-hint");
  const pwField = $("ctrl-pw-field");
  if (ctrlOs === "mac") {
    if (hint) hint.textContent = "(对方 Mac 的屏幕共享/VNC 密码)";
    if (pwField) pwField.style.display = "";
  } else {
    // Windows RDP: 填了用户名+密码可直接登录; 密码留空则连上后在弹窗里补输
    if (hint) hint.textContent = "(填密码可直接登录; 留空则在弹窗里补输)";
    if (pwField) pwField.style.display = "";
  }
}

async function onRemote() {
  if (isRemoting) return;

  const address = $("ctrl-address").value.trim();
  if (!address) {
    markError("ctrl-address");
    $("ctrl-address").focus();
    return;
  }
  // 简单校验 IP:端口 形式
  if (!/^.+:\d{1,5}$/.test(address)) {
    markError("ctrl-address");
    setCtrlStatus("error", "地址格式不对, 应为 IP:端口, 例如 1.2.3.4:7002");
    return;
  }

  const password = $("ctrl-password").value;
  const username = $("ctrl-username").value.trim(); // 对方用户名(选填, 仅用于记录)
  const kind = ctrlOs === "mac" ? "vnc" : "rdp";
  const invoke = getInvoke();

  const btn = $("btn-remote");
  isRemoting = true;
  btn.disabled = true;
  btn.classList.add("btn-disabled");
  btn.textContent = "连接中...";
  setCtrlStatus("connecting", "正在发起远程...");

  try {
    if (!invoke) {
      // 浏览器预览
      setTimeout(() => setCtrlStatus("ok", "(预览模式) 已发起远程"), 500);
      return;
    }

    // 探测端口是否可达(仅作提示, 不阻断)。
    // 关键: RDP(mstsc) 自带完善的连接/失败界面, 绝不能因为探测失败就不启动,
    //       否则用户看到的就是"点了没反应"。所以无论探测结果如何都继续 remote_connect。
    const [host, portStr] = splitAddress(address);
    let reachable = true;
    try {
      reachable = await invoke("probe_remote", { host, port: parseInt(portStr, 10) });
    } catch (e) {
      reachable = true; // 探测本身出错也别挡路
    }

    setCtrlStatus("connecting", "正在打开远程窗口...");
    const result = await invoke("remote_connect", { address, kind, password, username });
    if (result && result.ok) {
      // 探测不通但已启动: 给个温和提示; 通了就正常成功
      if (!reachable) {
        setCtrlStatus("ok", "已打开远程窗口。若连不上, 请确认对方已连线、端口已放行");
      } else {
        setCtrlStatus("ok", "✓ " + result.message);
      }
      addHistory(address, ctrlOs, username); // 记住这次远程(地址+系统+用户名, 不存密码)
    } else {
      const msg = result ? result.message : "远程失败";
      if (msg.startsWith("BLOCKED:")) {
        $("blocked-modal").classList.remove("hidden");
        setCtrlStatus("error", msg.replace("BLOCKED:", ""));
      } else {
        setCtrlStatus("error", msg);
      }
    }
  } catch (e) {
    setCtrlStatus("error", "远程出错: " + e);
  } finally {
    isRemoting = false;
    btn.disabled = false;
    btn.classList.remove("btn-disabled");
    btn.innerHTML = '<i class="bi bi-play-fill btn-icon"></i> 开始远程';
  }
}

// 拆 "host:port" -> [host, port] (取最后一个冒号, 兼容将来 IPv6 少见情况)
function splitAddress(addr) {
  const i = addr.lastIndexOf(":");
  return [addr.slice(0, i), addr.slice(i + 1)];
}

function setCtrlStatus(type, text) {
  const dot = $("ctrl-status-dot");
  const txt = $("ctrl-status-text");
  if (!dot || !txt) return;
  txt.textContent = text;
  dot.className = "status-dot";
  if (type === "connecting") {
    dot.classList.add("dot-connecting");
    txt.style.color = "";
  } else if (type === "error") {
    dot.classList.add("dot-off");
    txt.style.color = "var(--danger)";
  } else if (type === "ok") {
    dot.classList.add("dot-on");
    txt.style.color = "var(--success)";
  } else {
    dot.classList.add("dot-off");
    txt.style.color = "";
  }
}

// ---- 最近远程记录(存 localStorage, 仅地址+系统, 绝不存密码) ----
const CTRL_HISTORY_KEY = "pd-ctrl-history";
const CTRL_HISTORY_MAX = 5;

function getHistory() {
  try {
    const raw = localStorage.getItem(CTRL_HISTORY_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

// 新增/置顶一条记录: {address, os, user}
function addHistory(address, os, user) {
  let list = getHistory();
  // 去重(同地址): 先移除旧的, 再插到最前
  list = list.filter((h) => h.address !== address);
  list.unshift({ address, os, user: user || "" });
  if (list.length > CTRL_HISTORY_MAX) list = list.slice(0, CTRL_HISTORY_MAX);
  try { localStorage.setItem(CTRL_HISTORY_KEY, JSON.stringify(list)); } catch (e) {}
  renderHistory();
}

// 渲染最近远程列表
function renderHistory() {
  const box = $("ctrl-history");
  const listEl = $("ctrl-history-list");
  if (!box || !listEl) return;
  const list = getHistory();
  if (list.length === 0) {
    box.classList.add("hidden");
    listEl.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  listEl.innerHTML = "";
  list.forEach((h) => {
    const item = document.createElement("div");
    item.className = "history-item";
    const osLabel = h.os === "mac" ? "Mac" : "Windows";
    const osIcon = h.os === "mac" ? "bi-apple" : "bi-windows";
    // 用户名(选填): 有则显示在地址下方
    const userLine = h.user
      ? '<span class="hist-user"><i class="bi bi-person"></i>' + escapeHtml(h.user) + '</span>'
      : '';
    // 主体: 点击回填并可直接再连
    item.innerHTML =
      '<i class="bi ' + osIcon + ' hist-os"></i>' +
      '<span class="hist-main">' +
        '<span class="hist-addr">' + escapeHtml(h.address) + '</span>' +
        userLine +
      '</span>' +
      '<span class="hist-tag">' + osLabel + '</span>' +
      '<button class="hist-del" title="删除">&times;</button>';
    // 点条目 -> 回填地址、系统和用户名
    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("hist-del")) return; // 删除按钮单独处理
      $("ctrl-address").value = h.address;
      $("ctrl-username").value = h.user || "";
      setCtrlOs(h.os);
    });
    // 删除单条
    item.querySelector(".hist-del").addEventListener("click", (e) => {
      e.stopPropagation();
      removeHistory(h.address);
    });
    listEl.appendChild(item);
  });
}

function removeHistory(address) {
  let list = getHistory().filter((h) => h.address !== address);
  try { localStorage.setItem(CTRL_HISTORY_KEY, JSON.stringify(list)); } catch (e) {}
  renderHistory();
}

function clearHistory() {
  try { localStorage.removeItem(CTRL_HISTORY_KEY); } catch (e) {}
  renderHistory();
}

// 设置当前"对方系统"选择(同步按钮高亮 + 密码提示)
function setCtrlOs(os) {
  if (os !== "mac" && os !== "win") return;
  ctrlOs = os;
  document.querySelectorAll(".os-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.os === os)
  );
  applyCtrlOsUi();
}

// 简单转义, 防地址里的特殊字符破坏 HTML
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ============ 共享上网(代理) ============
let proxyRunning = false;
let isProxyToggling = false;

function initProxy() {
  // 载入/生成 账号密码
  loadOrGenProxyCred();
  // 载入上次的端口
  const savedPort = localStorage.getItem("pd-proxy-port");
  if (savedPort) $("proxy-port").value = savedPort;

  $("btn-proxy-toggle").addEventListener("click", onProxyToggle);
  $("btn-proxy-regen").addEventListener("click", () => {
    if (proxyRunning) return; // 运行中不允许改
    genProxyCred();
  });
  $("btn-proxy-copy").addEventListener("click", () => {
    copyText($("proxy-config-text").textContent);
    const span = $("btn-proxy-copy").querySelector("span");
    if (span) { const o = span.textContent; span.textContent = "已复制"; setTimeout(() => (span.textContent = o), 1500); }
  });
  $("btn-proxy-help").addEventListener("click", () => $("proxy-help-modal").classList.remove("hidden"));
  $("btn-proxy-help-close").addEventListener("click", () => $("proxy-help-modal").classList.add("hidden"));
  $("proxy-port").addEventListener("input", () => {
    localStorage.setItem("pd-proxy-port", $("proxy-port").value.trim());
  });
}

// 生成随机账号密码
function genProxyCred() {
  const user = "pd" + Math.random().toString(36).slice(2, 8);
  const pass = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  $("proxy-user").value = user;
  $("proxy-pass").value = pass;
  try {
    localStorage.setItem("pd-proxy-user", user);
    localStorage.setItem("pd-proxy-pass", pass);
  } catch (e) {}
}
function loadOrGenProxyCred() {
  const u = localStorage.getItem("pd-proxy-user");
  const p = localStorage.getItem("pd-proxy-pass");
  if (u && p) {
    $("proxy-user").value = u;
    $("proxy-pass").value = p;
  } else {
    genProxyCred();
  }
}

// 进入共享上网页时刷新: 检查是否有服务器信息、当前是否在运行
async function refreshProxyView() {
  const invoke = getInvoke();
  if (!invoke) return;
  // 检查服务器信息(profile)
  try {
    const p = await invoke("load_profile");
    const hasServer = p && p.server && p.port && p.token;
    $("proxy-need-server").classList.toggle("hidden", !!hasServer);
    $("btn-proxy-toggle").disabled = !hasServer;
  } catch (e) {}
  // 检查运行状态
  try {
    const running = await invoke("proxy_status");
    setProxyRunning(running);
  } catch (e) {}
}

async function onProxyToggle() {
  if (isProxyToggling) return;
  const invoke = getInvoke();
  if (!invoke) return;

  if (proxyRunning) {
    // 停止
    isProxyToggling = true;
    try {
      await invoke("stop_proxy_cmd");
      setProxyRunning(false);
      setProxyStatus("off", "未开启");
    } catch (e) {
      setProxyStatus("error", "停止出错: " + e);
    } finally {
      isProxyToggling = false;
    }
    return;
  }

  // 开启
  const remote_port = $("proxy-port").value.trim();
  if (!/^\d{1,5}$/.test(remote_port)) {
    markError("proxy-port");
    setProxyStatus("error", "代理端口应为数字, 如 6080");
    return;
  }
  const user = $("proxy-user").value.trim();
  const password = $("proxy-pass").value.trim();

  const btn = $("btn-proxy-toggle");
  isProxyToggling = true;
  btn.disabled = true;
  btn.classList.add("btn-disabled");
  btn.textContent = "开启中...";
  setProxyStatus("connecting", "正在开启共享上网...");

  try {
    const result = await invoke("start_proxy", { params: { remote_port, user, password } });
    if (result && result.ok) {
      setProxyRunning(true);
      setProxyStatus("ok", "✓ " + result.message);
      showProxyConfig(remote_port, user, password);
    } else {
      const msg = result ? result.message : "开启失败";
      if (msg.startsWith("BLOCKED:")) {
        $("blocked-modal").classList.remove("hidden");
        setProxyStatus("error", msg.replace("BLOCKED:", ""));
      } else {
        setProxyStatus("error", msg);
      }
    }
  } catch (e) {
    setProxyStatus("error", "开启出错: " + e);
  } finally {
    isProxyToggling = false;
    btn.disabled = false;
    btn.classList.remove("btn-disabled");
    // 按钮文字由 setProxyRunning 统一设置
    setProxyRunning(proxyRunning);
  }
}

// 显示给对方的配置串
function showProxyConfig(port, user, pass) {
  const invoke = getInvoke();
  // 服务器 IP 从 profile 取
  const render = (serverIp) => {
    const text =
      "类型: HTTP 代理\n" +
      "地址: " + serverIp + "\n" +
      "端口: " + port + "\n" +
      "账号: " + user + "\n" +
      "密码: " + pass;
    $("proxy-config-text").textContent = text;
    $("proxy-result").classList.remove("hidden");
  };
  if (invoke) {
    invoke("load_profile").then((p) => render((p && p.server) ? p.server : "你的服务器IP")).catch(() => render("你的服务器IP"));
  } else {
    render("你的服务器IP");
  }
}

// 设置运行状态(按钮外观 + 禁用改动)
function setProxyRunning(running) {
  proxyRunning = running;
  const btn = $("btn-proxy-toggle");
  if (running) {
    btn.innerHTML = '<i class="bi bi-stop-circle btn-icon"></i> 停止共享上网';
    btn.classList.add("btn-danger-look");
  } else {
    btn.innerHTML = '<i class="bi bi-globe2 btn-icon"></i> 开启共享上网';
    btn.classList.remove("btn-danger-look");
    $("proxy-result").classList.add("hidden");
  }
  // 运行中禁止改端口和账号密码
  $("proxy-port").disabled = running;
  $("btn-proxy-regen").disabled = running;
}

function setProxyStatus(type, text) {
  const dot = $("proxy-status-dot");
  const txt = $("proxy-status-text");
  if (!dot || !txt) return;
  txt.textContent = text;
  dot.className = "status-dot";
  if (type === "connecting") { dot.classList.add("dot-connecting"); txt.style.color = ""; }
  else if (type === "error") { dot.classList.add("dot-off"); txt.style.color = "var(--danger)"; }
  else if (type === "ok") { dot.classList.add("dot-on"); txt.style.color = "var(--success)"; }
  else { dot.classList.add("dot-off"); txt.style.color = ""; }
}

// ============ 全局共享(实验性 WireGuard 出口) ============
let fullTunnelRunning = false;
let isFullTunnelToggling = false;
let fullTunnelClientRunning = false;
let isFullTunnelClientToggling = false;

function initFullTunnel() {
  const savedPort = localStorage.getItem("pd-full-tunnel-port");
  if (savedPort) $("full-tunnel-port").value = savedPort;

  $("role-sharer").addEventListener("click", () => setFullTunnelRole("sharer"));
  $("role-receiver").addEventListener("click", () => setFullTunnelRole("receiver"));
  $("btn-full-tunnel-toggle").addEventListener("click", onFullTunnelToggle);
  $("btn-full-tunnel-client-toggle").addEventListener("click", onFullTunnelClientToggle);
  $("btn-copy-full-tunnel-config").addEventListener("click", () => {
    copyText($("full-tunnel-client-config").value, $("btn-copy-full-tunnel-config"));
  });
  $("full-tunnel-port").addEventListener("input", () => {
    localStorage.setItem("pd-full-tunnel-port", $("full-tunnel-port").value.trim());
  });
  $("full-tunnel-port").addEventListener("input", () => clearError("full-tunnel-port"));
  setFullTunnelRole(localStorage.getItem("pd-full-tunnel-role") === "receiver" ? "receiver" : "sharer");
  refreshFullTunnelView();
}

function setFullTunnelRole(role) {
  const receiver = role === "receiver";
  localStorage.setItem("pd-full-tunnel-role", receiver ? "receiver" : "sharer");
  $("role-sharer").classList.toggle("active", !receiver);
  $("role-receiver").classList.toggle("active", receiver);
  $("role-sharer").setAttribute("aria-selected", String(!receiver));
  $("role-receiver").setAttribute("aria-selected", String(receiver));
  $("full-tunnel-sharer-panel").classList.toggle("hidden", receiver);
  $("full-tunnel-receiver-panel").classList.toggle("hidden", !receiver);
  renderFullTunnelControls();
}

async function refreshFullTunnelView() {
  const invoke = getInvoke();
  if (!invoke) return;
  try {
    const running = !!(await invoke("full_tunnel_status"));
    setFullTunnelRunning(running);
    setFullTunnelStatus(running ? "ok" : "off", running ? "已开启" : "未开启");
  } catch (e) {
    console.error("full_tunnel_status", e);
  }
}

async function onFullTunnelToggle() {
  if (isFullTunnelToggling) return;
  const invoke = getInvoke();
  if (!invoke) {
    setFullTunnelStatus("error", "请在 PrivDesk 客户端中使用");
    return;
  }

  if (fullTunnelRunning) {
    await stopFullTunnel();
    return;
  }

  const remote_port = $("full-tunnel-port").value.trim();
  const port = Number(remote_port);
  if (!/^\d{1,5}$/.test(remote_port) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    markError("full-tunnel-port");
    setFullTunnelStatus("error", "全局共享端口应为 1024-65535 之间的数字");
    return;
  }

  isFullTunnelToggling = true;
  const btn = $("btn-full-tunnel-toggle");
  btn.disabled = true;
  btn.classList.add("btn-disabled");
  btn.textContent = "开启中...";
  setFullTunnelStatus("connecting", "正在配置 WireGuard 和网络转发...");
  setFullTunnelDiagnostics("正在收集管理员 PowerShell、WireGuard 和网络配置日志...");

  try {
    const result = await invoke("start_full_tunnel", { params: { remote_port } });
    setFullTunnelDiagnostics(result && result.diagnostics
      ? result.diagnostics
      : "后端没有返回诊断内容，请点击“打开日志目录”查看 full-tunnel.log。");
    if (result && result.ok) {
      setFullTunnelRunning(true);
      setFullTunnelStatus("ok", "✓ " + result.message);
      $("full-tunnel-client-config").value = result.client_config || "";
      $("full-tunnel-result").classList.remove("hidden");
    } else {
      setFullTunnelStatus("error", result ? result.message : "开启失败");
    }
  } catch (e) {
    setFullTunnelDiagnostics("前端调用异常：" + String(e));
    setFullTunnelStatus("error", "开启出错: " + e);
  } finally {
    isFullTunnelToggling = false;
    btn.disabled = false;
    btn.classList.remove("btn-disabled");
    setFullTunnelRunning(fullTunnelRunning);
  }
}

async function onFullTunnelClientToggle() {
  if (isFullTunnelClientToggling) return;
  const invoke = getInvoke();
  if (!invoke) {
    setFullTunnelStatus("error", "请在 PrivDesk 客户端中使用");
    return;
  }

  if (fullTunnelRunning || fullTunnelClientRunning) {
    await stopFullTunnel();
    return;
  }

  const config = $("full-tunnel-import-config").value.trim();
  if (!config) {
    setFullTunnelStatus("error", "请先粘贴共享者生成的 WireGuard 配置");
    return;
  }

  isFullTunnelClientToggling = true;
  const btn = $("btn-full-tunnel-client-toggle");
  btn.disabled = true;
  btn.classList.add("btn-disabled");
  btn.textContent = "开启中...";
  setFullTunnelStatus("connecting", "正在启动被共享网络...");
  setFullTunnelDiagnostics("正在收集管理员 PowerShell、WireGuard 和网络配置日志...");

  try {
    const result = await invoke("start_full_tunnel_client", { params: { config } });
    setFullTunnelDiagnostics(result && result.diagnostics
      ? result.diagnostics
      : "后端没有返回诊断内容，请点击“打开日志目录”查看 full-tunnel.log。");
    if (result && result.ok) {
      fullTunnelClientRunning = true;
      setFullTunnelRunning(true);
      setFullTunnelStatus("ok", "✓ " + result.message);
    } else {
      setFullTunnelStatus("error", result ? result.message : "开启失败");
    }
  } catch (e) {
    setFullTunnelDiagnostics("前端调用异常：" + String(e));
    setFullTunnelStatus("error", "开启出错: " + e);
  } finally {
    isFullTunnelClientToggling = false;
    btn.disabled = false;
    btn.classList.remove("btn-disabled");
    renderFullTunnelControls();
  }
}

async function stopFullTunnel() {
  const invoke = getInvoke();
  if (!invoke) return;
  isFullTunnelToggling = true;
  isFullTunnelClientToggling = true;
  try {
    await invoke("stop_full_tunnel_cmd");
    fullTunnelClientRunning = false;
    setFullTunnelRunning(false);
    setFullTunnelStatus("off", "未开启");
  } catch (e) {
    setFullTunnelStatus("error", "停止失败: " + e);
  } finally {
    isFullTunnelToggling = false;
    isFullTunnelClientToggling = false;
    renderFullTunnelControls();
  }
}

function setFullTunnelRunning(running) {
  fullTunnelRunning = running;
  if (!running) fullTunnelClientRunning = false;
  renderFullTunnelControls();
}

function renderFullTunnelControls() {
  const sharerBtn = $("btn-full-tunnel-toggle");
  const receiverBtn = $("btn-full-tunnel-client-toggle");
  const running = fullTunnelRunning;
  if (sharerBtn) {
    sharerBtn.innerHTML = running
      ? '<i class="bi bi-stop-circle btn-icon"></i> 停止全局共享'
      : '<i class="bi bi-router btn-icon"></i> 开启全局共享';
    sharerBtn.classList.toggle("btn-danger-look", running);
  }
  if (receiverBtn) {
    receiverBtn.innerHTML = running
      ? '<i class="bi bi-stop-circle btn-icon"></i> 停止被共享网络'
      : '<i class="bi bi-plug btn-icon"></i> 开启被共享网络';
    receiverBtn.classList.toggle("btn-danger-look", running);
  }
  $("full-tunnel-port").disabled = running;
  $("full-tunnel-import-config").disabled = running;
}

function setFullTunnelStatus(type, text) {
  [["full-tunnel-status-dot", "full-tunnel-status-text"], ["full-tunnel-client-status-dot", "full-tunnel-client-status-text"]]
    .forEach(([dotId, textId]) => {
      const dot = $(dotId);
      const txt = $(textId);
      if (!dot || !txt) return;
      txt.textContent = text;
      dot.className = "status-dot";
      if (type === "connecting") { dot.classList.add("dot-connecting"); txt.style.color = ""; }
      else if (type === "error") { dot.classList.add("dot-off"); txt.style.color = "var(--danger)"; }
      else if (type === "ok") { dot.classList.add("dot-on"); txt.style.color = "var(--success)"; }
      else { dot.classList.add("dot-off"); txt.style.color = ""; }
    });
}

function setFullTunnelDiagnostics(text) {
  const panel = $("full-tunnel-diagnostics");
  const output = $("full-tunnel-diagnostics-text");
  if (!panel || !output) return;
  panel.classList.remove("hidden");
  output.textContent = String(text || "没有可显示的诊断日志。");
}

