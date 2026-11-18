// Тесты подтверждений: check.mjs гоняется как отдельный процесс против ЛОКАЛЬНОГО HTTP-сервера,
// который отдаёт заранее заданные события. Ни сети, ни живого API — детерминированно.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK = fileURLToPath(new URL("../check.mjs", import.meta.url));
const HIGH = { eventId: "eb9c6cb717f2e882", id: "@modelcontextprotocol/sdk", type: "maintainer_changed", severity: "high",
  at: "2026-09-18T01:33:01.592Z", headline: "Package ownership changed.", version: "1.30.0", prevVersion: "1.30.0" };
const HIGH2 = { ...HIGH, eventId: "0123456789abcdef", at: "2026-09-19T01:33:01.592Z", headline: "Another maintainer change." };
const LOW = { eventId: "ffffffffffffffff", id: "@modelcontextprotocol/sdk", type: "version_published", severity: "low", at: "2026-09-10T00:00:00Z", headline: "New version." };

async function withServer(events, fn, { status = 200, requested, coverage, total, windowDays } = {}) {
  const srv = createServer((req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ events, requested, coverage, total, windowDays }));
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); }
}

// Асинхронно: сервер живёт в этом же процессе, и синхронный запуск заблокировал бы цикл событий —
// дочерний check.mjs ждал бы ответа вечно (первая версия теста так и висла).
function run(api, { allowlist, failOn = "high", packages = "@modelcontextprotocol/sdk", selfCheck = false, auto = false, approved = "", manifest, outputIsDirectory = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mda-"));
  if (manifest) writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  const outFile = join(dir, "gh-output");
  if (allowlist !== undefined) writeFileSync(join(dir, ".mcp-drift-allowlist.json"), typeof allowlist === "string" ? allowlist : JSON.stringify(allowlist));
  const summaryFile = join(dir, "summary");
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CHECK], { cwd: dir,
      env: { ...process.env, INPUT_SHARE_DISCOVERED: String(auto), INPUT_APPROVED_DISCOVERED_PACKAGES: approved, INPUT_API: api, INPUT_PACKAGES: packages, PULSEFEED_SELF_CHECK: String(selfCheck), INPUT_FAIL_ON: failOn, GITHUB_OUTPUT: outputIsDirectory ? dir : outFile, GITHUB_STEP_SUMMARY: summaryFile } });
    let out = "";
    child.stdout.on("data", d => out += d); child.stderr.on("data", d => out += d);
    child.on("close", code => {
      let outputs = {};
      try { for (const l of readFileSync(outFile, "utf8").split("\n")) { const [k, v] = l.split("="); if (k) outputs[k] = v; } } catch {}
      const summary = readFileSync(summaryFile, "utf8");
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, out, outputs, summary });
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

test("подтверждённое событие: сборка зелёная, событие отмечено в журнале, выходы считают открытое", () => withServer([HIGH, LOW], async api => {
  const r = await run(api, { allowlist: { reviewed: [ACK] } });
  assert.equal(r.code, 0);
  assert.match(r.out, /✅ @modelcontextprotocol\/sdk: maintainer changed — acknowledged \(eb9c6cb717f2e882\)/);
  assert.equal(r.outputs.events, "0"); assert.equal(r.outputs.high, "0"); assert.equal(r.outputs.acknowledged, "1");
}));

test("подтверждение привязано к событию, не к пакету: новая смена на том же пакете снова роняет", () => withServer([HIGH, HIGH2], async api => {
  const r = await run(api, { allowlist: { reviewed: [ACK] } });
  assert.equal(r.code, 1);
  assert.match(r.out, /✅ .*acknowledged/);
  assert.match(r.out, new RegExp(`"eventId":"${HIGH2.eventId}"`));
  assert.equal(r.outputs.high, "1"); assert.equal(r.outputs.acknowledged, "1");
}));

test("подтверждение с чужим пакетом не действует и объясняет почему", () => withServer([HIGH], async api => {
  const r = await run(api, { allowlist: { reviewed: [{ ...ACK, package: "some-other-package" }] } });
  assert.equal(r.code, 1);
  assert.match(r.out, /package differs from the event on @modelcontextprotocol\/sdk — ignored/);
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

const selfCheckPackages = ["@modelcontextprotocol/server-filesystem", "mcp-remote", "@upstash/context7-mcp"];
const selfCheckOptions = { packages: selfCheckPackages.join(","), failOn: "never", selfCheck: true };

test("self-check accepts a scoped empty feed", () => withServer([], async api => {
  const r = await run(api, selfCheckOptions);
  assert.equal(r.code, 0);
  assert.match(r.out, /3 package\(s\)/);
}, { requested: selfCheckPackages }));

test("HTTP 502 fails the self-check but preserves ordinary CI's fail-open behavior", () => withServer([], async api => {
  assert.equal((await run(api, selfCheckOptions)).code, 1);
  assert.equal((await run(api)).code, 0);
}, { status: 502 }));

test("self-check rejects a missing scope, omitted package or invalid events", async () => {
  for (const [events, requested] of [[[], undefined], [[], selfCheckPackages.slice(1)], [{}, selfCheckPackages], [[{}], selfCheckPackages]]) {
    await withServer(events, async api => {
      assert.equal((await run(api, selfCheckOptions)).code, 1);
    }, { requested });
  }
});

test("self-check cannot pass when there are no input packages", async () => {
  const r = await run("http://127.0.0.1", { ...selfCheckOptions, packages: "" });
  assert.equal(r.code, 1);
});

test("outputs distinguish quiet audited routes, absence of evidence, and HTTP failure", async () => {
  const requested = [HIGH.id];
  for (const [coverage, status] of [
    [{ observed: requested, sourcesComplete: true }, "no_notable_events"],
    [{ observed: [], sourcesComplete: true }, "unknown_coverage"],
    [{ observed: requested, sourcesComplete: false }, "partial"],
  ]) {
    await withServer([], async api => {
      const { outputs } = await run(api);
      assert.equal(outputs.check_status, status);
      assert.equal(outputs.coverage_complete, String(status === "no_notable_events"));
      assert.equal(outputs.unknown, String(1 - coverage.observed.length));
    }, { requested, coverage, total: 0 });
  }
  await withServer([], async api => assert.equal((await run(api)).outputs.check_status, "unavailable"), { status: 503 });
});

test("truncation remains visible even with an actionable event", () => withServer([HIGH], async api => {
  const { outputs } = await run(api);
  assert.equal(outputs.check_status, "notable");
  assert.equal(outputs.coverage_complete, "false");
  assert.equal(outputs.truncated, "true");
}, { total: 2, requested: [HIGH.id], coverage: { observed: [HIGH.id], sourcesComplete: true } }));

test("discovery requests only exact approved matches and sends nothing on a missing policy", async () => {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push(new URL(req.url, "http://localhost").searchParams.get("packages"));
    res.end(JSON.stringify({ events: [] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const api = "http://127.0.0.1:" + server.address().port;
    const options = { packages: "", manifest: { dependencies: { "@private/fixture": "*", "public-demo": "*" } } };
    assert.equal((await run(api, options)).outputs.check_status, "not_checked");
    assert.equal((await run(api, { ...options, approved: "public-demo" })).outputs.check_status, "not_checked");
    const missing = await run(api, { ...options, auto: true });
    assert.equal(missing.code, 1);
    assert.equal(missing.outputs.check_status, "not_checked");
    const invalid = await run(api, { ...options, auto: true, approved: "public-demo,@private/*" });
    assert.equal(invalid.code, 1);
    assert.deepEqual(calls, []);
    await run(api, { ...options, auto: true, approved: "public-demo,missing" });
    assert.deepEqual(calls, ["public-demo"]);
    await run(api, { ...options, packages: ", ,", auto: true, approved: "public-demo" });
    assert.deepEqual(calls, ["public-demo"]);
  } finally { server.close(); }
});

test("only the approved API prefix receives a request and redirects are declined", async () => {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push(new URL(req.url, "http://localhost").pathname);
    res.writeHead(302, { location: "/other" }); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = "http://127.0.0.1:" + server.address().port;
    for (const bad of [base + "?secret=fixture", base + "#fixture", base.replace("://", "://user:fixture@")]) {
      const result = await run(bad);
      assert.equal(result.code, 1);
      assert.equal(result.outputs.check_status, "not_checked");
      assert.doesNotMatch(result.out + result.summary, /fixture/);
    }
    assert.deepEqual(calls, []);
    const redirected = await run(base + "/api/v1/");
    assert.equal(redirected.outputs.source_error, "true");
    assert.deepEqual(calls, ["/api/v1/mcp/drift.json"]);
  } finally { server.close(); }
});

test("a later outage does not erase a confirmed high or the policy decision", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    const names = new URL(req.url, "http://localhost").searchParams.get("packages").split(",");
    if (++calls === 1) res.end(JSON.stringify({ requested: names, events: [HIGH], total: 1 }));
    else { res.writeHead(503); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const packages = [HIGH.id, ...Array.from({length:200}, (_, n) => "demo-" + n), "invalid/name/private"].join(",");
    const result = await run("http://127.0.0.1:" + server.address().port, { packages });
    assert.equal(result.code, 1);
    assert.equal(result.outputs.check_status, "notable");
    assert.equal(result.outputs.high, "1");
    assert.equal(result.outputs.source_error, "true");
    assert.equal(result.outputs.coverage_complete, "false");
    assert.equal(result.outputs.invalid_inputs, "1");
    assert.equal(result.outputs.unknown, "201");
  } finally { server.close(); }
});

test("missing feed total cannot confirm completeness", () => withServer([], async api => {
  const { outputs } = await run(api);
  assert.equal(outputs.coverage_complete, "false");
  assert.equal(outputs.check_status, "partial");
}, { requested: [HIGH.id], coverage: { observed: [HIGH.id], sourcesComplete: true } }));

test("candidate default is advisory even with a confirmed high; summary separates findings, coverage and baseline", () =>
  withServer([HIGH, LOW], async api => {
    const { code, outputs, summary } = await run(api, { failOn: "" });
    assert.equal(code, 0);
    assert.deepEqual(outputs, {
      check_status: "notable", coverage_status: "complete", coverage_complete: "true", covered: "1",
      unknown: "0", source_error: "false", invalid_inputs: "0", truncated: "false", events: "1",
      high: "1", acknowledged: "0", routine: "1", notable: "1", baseline_status: "unknown", fail_on: "never",
    });
    assert.match(summary, /Coverage: \*\*complete\*\*/);
    assert.match(summary, /baseline: \*\*unknown\*\*/);
    assert.match(summary, /threshold: \*\*never\*\*/);
  }, { requested: [HIGH.id], coverage: { observed: [HIGH.id], sourcesComplete: true }, total: 2 }));

test("all acknowledged events remain notable; a review of an event cannot establish a package baseline", () =>
  withServer([HIGH], async api => {
    const { outputs, code } = await run(api, { allowlist: [ACK] });
    assert.equal(outputs.check_status, "notable"); assert.equal(outputs.notable, "1");
    assert.equal(outputs.acknowledged, "1"); assert.equal(outputs.events, "0"); assert.equal(code, 0);
    assert.equal(outputs.baseline_status, "unknown");
  }));

test("invalid CI failure policy is visible and does not send a request", async () => {
  const result = await run("http://127.0.0.1:1", { failOn: "hgh" });
  assert.equal(result.code, 1);
  assert.equal(result.outputs.check_status, "not_checked");
  assert.equal(result.outputs.source_error, "false");
  assert.equal(result.outputs.fail_on, "invalid");
  assert.match(result.summary, /not_checked/);
});

test("self-check publishes all counters when the first or the last request fails", async () => {
  for (const failFirst of [true, false]) {
    let calls = 0;
    const server = createServer((req, res) => {
      const names = new URL(req.url, "http://localhost").searchParams.get("packages").split(",");
      if ((++calls === 1) === failFirst) { res.writeHead(503); res.end(); return; }
      res.end(JSON.stringify({ requested: names, total: 1, events: [{ ...HIGH, id: names[0] }],
        coverage: { observed: names, sourcesComplete: true } }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const packages = Array.from({ length: 201 }, (_, i) => "demo-" + i).join(",");
      const { code, outputs, summary } = await run("http://127.0.0.1:" + server.address().port, { packages, failOn: "never", selfCheck: true });
      assert.equal(calls, 2); assert.equal(code, 1);
      assert.equal(outputs.coverage_status, "partial"); assert.equal(outputs.check_status, "notable");
      assert.equal(outputs.source_error, "true"); assert.equal(outputs.events, "1");
      assert.equal(outputs.high, "1"); assert.equal(outputs.acknowledged, "0");
      assert.match(summary, /Source error: true/);
    } finally { server.close(); }
  }
});

test("a wrong window or invalid coverage cannot set truncation for a rejected batch", async () => {
  for (const metadata of [
    { coverage: { observed: null, sourcesComplete: true } },
    { coverage: { observed: [HIGH.id], sourcesComplete: true }, windowDays: 1 },
  ]) await withServer([HIGH], async api => {
    const { outputs } = await run(api);
    assert.equal(outputs.truncated, "false");
    assert.equal(outputs.coverage_status, "unavailable");
    assert.equal(outputs.source_error, "true");
  }, { requested: [HIGH.id], total: 2, ...metadata });
});

test("an explicit source-read failure takes precedence over zero observed packages", () =>
  withServer([], async api => {
    const { code, outputs, summary } = await run(api);
    assert.equal(code, 0); assert.equal(outputs.coverage_status, "partial"); assert.equal(outputs.check_status, "partial");
    assert.match(summary, /Coverage: \*\*partial\*\*/);
    assert.equal((await run(api, { selfCheck: true })).code, 1);
  }, { requested: [HIGH.id], total: 0, coverage: { observed: [], sourcesComplete: false } }));

test("long scoped package names fit in bounded request targets without losing packages", async () => {
  const packages = Array.from({ length: 110 }, (_, i) => "@scope/" + "x".repeat(190) + i);
  const sent = [];
  const server = createServer((req, res) => {
    assert.ok(req.url.length < 6200);
    const names = new URL(req.url, "http://localhost").searchParams.get("packages").split(",");
    sent.push(...names);
    res.end(JSON.stringify({ requested: names, total: 0, events: [], coverage: { observed: names, sourcesComplete: true } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await run("http://127.0.0.1:" + server.address().port, { packages: packages.join(",") });
    assert.deepEqual(sent, packages); assert.equal(result.outputs.covered, "110");
    assert.equal(result.outputs.coverage_status, "complete");
  } finally { server.close(); }
});

test("an unwritable runner output fails advisory mode and still writes the available summary", () =>
  withServer([], async api => {
    const result = await run(api, { failOn: "never", outputIsDirectory: true });
    assert.equal(result.code, 1);
    assert.match(result.out, /could not write GITHUB_OUTPUT/);
    assert.deepEqual(result.outputs, {});
    assert.match(result.summary, /no_notable_events/);
  }, { requested: [HIGH.id], total: 0, coverage: { observed: [HIGH.id], sourcesComplete: true } }));
