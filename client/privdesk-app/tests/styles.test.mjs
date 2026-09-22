import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const index = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

test("content keeps scrolling available without showing a scrollbar", () => {
  assert.match(styles, /\.content\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(styles, /\.content\s*\{[\s\S]*?scrollbar-width:\s*none/);
  assert.match(styles, /\.content\s*\{[\s\S]*?-ms-overflow-style:\s*none/);
  assert.match(styles, /\.content::\-webkit-scrollbar\s*\{[\s\S]*?display:\s*none/);
});

test("new installations use the pure black theme by default", () => {
  assert.match(index, /<html[^>]*data-theme="black"[^>]*data-accent="black"/);
  assert.match(app, /localStorage\.getItem\("pd-theme"\)\s*\|\|\s*"black"/);
  assert.match(app, /localStorage\.getItem\("pd-accent"\)\s*\|\|\s*"black"/);
});

test("server settings can generate and copy a connection code", () => {
  assert.match(index, /id="btn-server-settings"/);
  assert.match(index, /id="settings-server"/);
  assert.match(index, /id="btn-generate-code"/);
  assert.match(index, /id="settings-generated-code"/);
  assert.match(index, /<script type="module" src="app\.js"><\/script>/);
  assert.match(app, /encodeConnectionCode/);
  assert.match(app, /invoke\("save_profile"/);
});

test("settings surfaces keep scrolling usable without visible scrollbars", () => {
  assert.match(styles, /\.settings-modal\s*\{[\s\S]*?scrollbar-width:\s*none/);
  assert.match(styles, /\.settings-modal\s*\{[\s\S]*?-ms-overflow-style:\s*none/);
  assert.match(styles, /\.settings-modal::-webkit-scrollbar\s*\{[\s\S]*?display:\s*none/);
  assert.match(styles, /\.settings-code-row textarea\s*\{[\s\S]*?scrollbar-width:\s*none/);
  assert.match(styles, /\.settings-code-row textarea::-webkit-scrollbar\s*\{[\s\S]*?display:\s*none/);
});

test("all scrollable surfaces keep scrolling without visible scrollbars", () => {
  assert.match(styles, /\*\s*\{[\s\S]*?scrollbar-width:\s*none/);
  assert.match(styles, /\*::-webkit-scrollbar\s*\{[\s\S]*?display:\s*none/);
  assert.match(styles, /\.full-tunnel-config\s*\{[\s\S]*?overflow:\s*auto/);
  assert.match(styles, /\.full-tunnel-diagnostics pre\s*\{[\s\S]*?overflow:\s*auto/);
});
