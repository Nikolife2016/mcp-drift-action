// Тесты подтверждений: check.mjs гоняется как отдельный процесс против ЛОКАЛЬНОГО HTTP-сервера,
// который отдаёт заранее заданные события. Ни сети, ни живого API — детерминированно.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECK = new URL("../check.mjs", import.meta.url).pathname;
const HIGH = { eventId: "eb9c6cb717f2e882", id: "@modelcontextprotocol/sdk", type: "maintainer_changed", severity: "high",
  at: "2026-09-18T01:33:01.592Z", headline: "Package ownership changed.", version: "1.30.0", prevVersion: "1.30.0" };
const HIGH2 = { ...HIGH, eventId: "0123456789abcdef", at: "2026-09-19T01:33:01.592Z", headline: "Another maintainer change." };
const LOW = { eventId: "ffffffffffffffff", id: "@modelcontextprotocol/sdk", type: "version_published", severity: "low", at: "2026-09-10T00:00:00Z", headline: "New version." };

async function withServer(events, fn) {
  const srv = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ events })); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

// Асинхронно: сервер живёт в этом же процессе, и синхронный запуск заблокировал бы цикл событий —
// дочерний check.mjs ждал бы ответа вечно (первая версия теста так и висла).
function run(api, { allowlist, failOn = "high" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mda-"));
  const outFile = join(dir, "gh-output");
  if (allowlist !== undefined) writeFileSync(join(dir, ".mcp-drift-allowlist.json"), typeof allowlist === "string" ? allowlist : JSON.stringify(allowlist));
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CHECK], { cwd: dir,
      env: { ...process.env, INPUT_API: api, INPUT_PACKAGES: "@modelcontextprotocol/sdk", INPUT_FAIL_ON: failOn, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: "" } });
    let out = "";
    child.stdout.on("data", d => out += d); child.stderr.on("data", d => out += d);
    child.on("close", code => {
      let outputs = {};
      try { for (const l of readFileSync(outFile, "utf8").split("\n")) { const [k, v] = l.split("="); if (k) outputs[k] = v; } } catch {}
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, out, outputs });
    });
  });
}

const ACK = { eventId: HIGH.eventId, package: HIGH.id, type: HIGH.type, reviewedBy: "nikolife", reviewedAt: "2026-09-19", reason: "ashwin-ant left the team; confirmed" };

test("high событие без файла подтверждений роняет сборку и печатает фрагмент для вставки", () => withServer([HIGH, LOW], async api => {
  const r = await run(api);
  assert.equal(r.code, 1);
  assert.match(r.out, /Failing the build/);
  assert.match(r.out, new RegExp(`"eventId":"${HIGH.eventId}"`));
  assert.equal(r.outputs.events, "1"); assert.equal(r.outputs.high, "1"); assert.equal(r.outputs.acknowledged, "0");
}));

test("подтверждённое событие: сборка зелёная, событие напечатано с автором, выходы считают открытое", () => withServer([HIGH, LOW], async api => {
  const r = await run(api, { allowlist: { reviewed: [ACK] } });
  assert.equal(r.code, 0);
  assert.match(r.out, /✅ @modelcontextprotocol\/sdk: maintainer changed — acknowledged by nikolife on 2026-09-19/);
  assert.equal(r.outputs.events, "0"); assert.equal(r.outputs.high, "0"); assert.equal(r.outputs.acknowledged, "1");
}));

test("подтверждение привязано к событию, не к пакету: новая смена на том же пакете снова роняет", () => withServer([HIGH, HIGH2], async api => {
  const r = await run(api, { allowlist: { reviewed: [ACK] } });
  assert.equal(r.code, 1);
  assert.match(r.out, /✅ .*acknowledged by nikolife/);
  assert.match(r.out, new RegExp(`"eventId":"${HIGH2.eventId}"`));
  assert.equal(r.outputs.high, "1"); assert.equal(r.outputs.acknowledged, "1");
}));

test("подтверждение с чужим пакетом не действует и объясняет почему", () => withServer([HIGH], async api => {
  const r = await run(api, { allowlist: { reviewed: [{ ...ACK, package: "some-other-package" }] } });
  assert.equal(r.code, 1);
  assert.match(r.out, /names package some-other-package, but the event is on @modelcontextprotocol\/sdk — ignored/);
}));

test("запись без причины или автора игнорируется с предупреждением, сборка красная", () => withServer([HIGH], async api => {
  const r = await run(api, { allowlist: { reviewed: [{ eventId: HIGH.eventId, reviewedBy: "nikolife", reviewedAt: "2026-09-19", reason: "" }] } });
  assert.equal(r.code, 1);
  assert.match(r.out, /1 entry ignored \(index 0\)/);
}));

test("нечитаемый файл подтверждений = подтверждений нет: сборка красная, причина названа", () => withServer([HIGH], async api => {
  const r = await run(api, { allowlist: "{ not json" });
  assert.equal(r.code, 1);
  assert.match(r.out, /is not valid JSON/);
}));

test("fail-on: never — открытое событие печатается, сборка зелёная, выходы честные", () => withServer([HIGH], async api => {
  const r = await run(api, { failOn: "never" });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.high, "1"); assert.equal(r.outputs.acknowledged, "0");
}));

test("контроль: без событий подтверждения ничего не меняют", () => withServer([LOW], async api => {
  const r = await run(api, { allowlist: { reviewed: [ACK] } });
  assert.equal(r.code, 0);
  assert.match(r.out, /No notable drift/);
  assert.equal(r.outputs.acknowledged, "0");
}));
