import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeConnectionCode,
  decodeConnectionCode,
  validateConnectionInfo,
} from "../src/connection-code.js";

const validInfo = {
  server: "example.com",
  port: "7000",
  token: "server-token-123",
  remote: "7002",
};

test("generates a PRIVDESK connection code that round-trips", () => {
  const code = encodeConnectionCode(validInfo);

  assert.match(code, /^PRIVDESK-/);
  assert.deepEqual(decodeConnectionCode(code), validInfo);
});

test("round-trips Unicode server names without corrupting the code", () => {
  const info = { ...validInfo, server: "服务器.example" };

  assert.deepEqual(decodeConnectionCode(encodeConnectionCode(info)), info);
});

test("rejects incomplete connection information", () => {
  assert.throws(
    () => encodeConnectionCode({ ...validInfo, token: "" }),
    /认证密钥不能为空/
  );
});

test("rejects unsafe server address input", () => {
  assert.equal(validateConnectionInfo({ ...validInfo, server: "https://evil.example/path" }).ok, false);
  assert.equal(validateConnectionInfo({ ...validInfo, server: "example.com:7000" }).ok, false);
  assert.throws(
    () => encodeConnectionCode({ ...validInfo, server: "https://evil.example/path" }),
    /服务器地址格式不正确/
  );
});

test("rejects ports outside the TCP port range", () => {
  assert.throws(
    () => encodeConnectionCode({ ...validInfo, port: "70000" }),
    /连接端口必须是 1-65535 之间的数字/
  );
  assert.throws(
    () => encodeConnectionCode({ ...validInfo, remote: "80" }),
    /远程端口必须是 1024-65535 之间的数字/
  );
});

test("rejects malformed or oversized codes", () => {
  assert.throws(() => decodeConnectionCode("not-a-privdesk-code"), /连接码格式不正确/);
  assert.throws(() => decodeConnectionCode("PRIVDESK-AAAA"), /连接码内容无效/);
});
