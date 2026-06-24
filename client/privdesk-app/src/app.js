// ===== PrivDesk 客户端 - 界面交互逻辑 =====
// 自动适配: 在 Tauri 中调用真实后端; 在浏览器预览中用模拟。

const $ = (id) => document.getElementById(id);

let uptimeTimer = null;
let uptimeSeconds = 0;
let isConnecting = false; // 防止连接中重复点击
let currentRemoteAddr = ""; // 当前远程地址(给"对方怎么连"弹窗用)

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
window.addEventListener("DOMContentLoaded", () => {
  bindEvents();
});

function bindEvents() {
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
      const json = atob(code.replace(/^PRIVDESK-/, ""));
      const data = JSON.parse(json);
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
    alert("PrivDesk 帮助\n\n1. 在服务端运行安装脚本, 获取连接信息\n2. 把连接码粘贴到这里, 或手动填写\n3. 点击\"连接\"即可\n4. 把生成的远程地址发给对方, 对方用远程桌面连接");
  });

  // ---------- 查看日志 (连接失败时引导) ----------
  $("btn-view-log").addEventListener("click", () => {
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
    $("how-address").textContent = currentRemoteAddr || "—";
    $("how-username").textContent = username || "—";
    $("how-modal").classList.remove("hidden");
  });
  $("btn-how-close").addEventListener("click", () => {
    $("how-modal").classList.add("hidden");
  });
  $("btn-how-copy").addEventListener("click", () => {
    const username = $("login-username").textContent;
    const text =
      "【远程连接我的电脑】\n" +
      "1. 同时按 Win+R, 输入 mstsc 回车\n" +
      "2. 计算机填: " + (currentRemoteAddr || "") + "\n" +
      "3. 用户名填: " + (username || "") + "\n" +
      "4. 密码: 我这台电脑的开机登录密码";
    copyText(text);
    const btn = $("btn-how-copy");
    const old = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(() => (btn.textContent = old), 1500);
  });
  $("cb-autostart").addEventListener("change", async (e) => {
    const invoke = getInvoke();
    if (invoke) {
      try {
        const ok = await invoke("set_autostart", { enable: e.target.checked });
        if (!ok) {
          // 设置失败, 回滚勾选状态
          e.target.checked = !e.target.checked;
        }
      } catch (err) {
        console.error("set_autostart", err);
        e.target.checked = !e.target.checked;
      }
    }
  });
}

// 启动时读取开机自启的真实状态, 同步到复选框
async function initAutostart() {
  const invoke = getInvoke();
  if (invoke) {
    try {
      const enabled = await invoke("get_autostart");
      $("cb-autostart").checked = !!enabled;
    } catch (e) {
      console.error("get_autostart", e);
    }
  }
}

// ========== 主题切换 ==========
function initTheme() {
  // 读取保存的主题(默认: 深色 + 蓝色)
  const theme = localStorage.getItem("pd-theme") || "dark";
  const accent = localStorage.getItem("pd-accent") || "blue";
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
      const a = localStorage.getItem("pd-accent") || "blue";
      applyTheme(btn.dataset.theme, a);
    });
  });
  // 主题色按钮
  document.querySelectorAll(".color-dot").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = localStorage.getItem("pd-theme") || "dark";
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
let lastRdpState = null; // 记录上次状态, 避免重复操作

async function checkRdp() {
  const invoke = getInvoke();
  if (!invoke) return; // 浏览器预览跳过
  try {
    const enabled = await invoke("check_rdp_enabled");
    // 状态没变化就不重复操作 DOM
    if (enabled === lastRdpState) return;
    lastRdpState = enabled;
    if (enabled) {
      $("rdp-status").classList.add("hidden");
      $("rdp-ok").classList.remove("hidden");
    } else {
      $("rdp-ok").classList.add("hidden");
      $("rdp-status").classList.remove("hidden");
    }
  } catch (e) {
    console.error("check_rdp", e);
  }
}

async function onEnableRdp() {
  const invoke = getInvoke();
  if (!invoke) return;
  const btn = $("btn-enable-rdp");
  btn.disabled = true;
  btn.textContent = "开启中...";
  try {
    await invoke("enable_rdp");
    // 等待 UAC 授权 + 生效, 再重新检测
    setTimeout(async () => {
      await checkRdp();
      btn.disabled = false;
      btn.textContent = "一键开启";
    }, 2500);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "一键开启";
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
    }
  } catch (e) {
    console.error("load_profile", e);
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
    invoke("connect", { params: { server, port, token, remote } })
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

  const server = fields[0].val;
  const port = fields[1].val;
  const token = fields[2].val;
  const remote = fields[3].val;

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
        params: { server, port, token, remote },
      });
      if (result && result.ok) {
        // 连接成功: 保存连接信息到本地
        try { await invoke("save_profile", { params: { server, port, token, remote } }); } catch (e) {}
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
function copyText(text) {
  const done = () => {
    const span = $("btn-copy").querySelector("span");
    if (!span) return;
    const old = span.textContent;
    span.textContent = "已复制";
    setTimeout(() => (span.textContent = old), 1500);
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
