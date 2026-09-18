const CODE_PREFIX = "PRIVDESK-";
const MAX_TOKEN_LENGTH = 256;

function asText(value) {
  return String(value ?? "").trim();
}

function isValidServerAddress(value) {
  const server = asText(value);
  if (!server || server.length > 253) return false;
  if (/\s|[\\/\\@?#"'<>;=]/u.test(server)) return false;
  if (server.startsWith("[") || server.endsWith("]")) {
    return /^\[[0-9a-fA-F:]+\]$/u.test(server);
  }
  if (server.includes(":")) return /^[0-9a-fA-F:]+$/u.test(server);
  return server.split(".").every((label) =>
    label.length > 0 && label.length <= 63 && /^[\p{L}\p{N}_-]+$/u.test(label)
  );
}

function isValidPort(value, minimum) {
  const port = asText(value);
  if (!/^\d+$/u.test(port)) return false;
  const number = Number(port);
  return Number.isInteger(number) && number >= minimum && number <= 65535;
}

function isValidToken(value) {
  const token = asText(value);
  return token.length > 0 && token.length <= MAX_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/u.test(token);
}

export function validateConnectionInfo(input = {}) {
  const value = {
    server: asText(input.server),
    port: asText(input.port),
    token: asText(input.token),
    remote: asText(input.remote),
  };
  const errors = {};

  if (!isValidServerAddress(value.server)) {
    errors.server = "服务器地址格式不正确";
  }
  if (!isValidPort(value.port, 1)) {
    errors.port = "连接端口必须是 1-65535 之间的数字";
  }
  if (!isValidToken(value.token)) {
    errors.token = "认证密钥不能为空且只能包含字母、数字、下划线或短横线";
  }
  if (!isValidPort(value.remote, 1024)) {
    errors.remote = "远程端口必须是 1024-65535 之间的数字";
  }

  return { ok: Object.keys(errors).length === 0, errors, value };
}

function encodeUtf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeUtf8(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function encodeConnectionCode(input) {
  const result = validateConnectionInfo(input);
  if (!result.ok) {
    const firstError = Object.values(result.errors)[0];
    throw new Error(firstError);
  }
  return CODE_PREFIX + encodeUtf8(JSON.stringify(result.value));
}

export function decodeConnectionCode(input) {
  const code = asText(input);
  if (!code.startsWith(CODE_PREFIX) || code.length > 4096) {
    throw new Error("连接码格式不正确");
  }

  try {
    const value = JSON.parse(decodeUtf8(code.slice(CODE_PREFIX.length)));
    const result = validateConnectionInfo(value);
    if (!result.ok) throw new Error("连接码内容无效");
    return result.value;
  } catch (error) {
    if (error.message === "连接码内容无效") throw error;
    throw new Error("连接码内容无效");
  }
}
