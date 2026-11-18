import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../check.mjs", import.meta.url));
const approved = "@example/public";
const marker = "private-canary-r04";
const id = "a1b2c3d4e5f60789";
const knownEvent = { id: approved, eventId: id, type: "maintainer_changed", severity: "high",
  headline: marker + "-headline", version: marker + "-version", prevVersion: marker + "-previous" };
const review = { eventId: id, package: approved, type: "maintainer_changed",
  reviewedBy: marker + "-person", reviewedAt: "2026-11-18", reason: marker + "-reason" };

async function check(events, reviews) {
  const cwd = mkdtempSync(join(tmpdir(), "r04-private-test-"));
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ windowDays: 30, requested: [approved], total: events.length,
      coverage: { observed: [approved], sourcesComplete: true }, events }));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const allowlist = join(cwd, marker + "-reviews.json");
    writeFileSync(allowlist, typeof reviews === "string" ? reviews : JSON.stringify({ reviewed: reviews }));
    const outputs = join(cwd, "outputs"), summary = join(cwd, "summary");
    const child = spawn(process.execPath, [cli], {cwd, env: {
      INPUT_PACKAGES: approved, INPUT_FAIL_ON: "high", INPUT_ALLOWLIST: allowlist,
      INPUT_API: `http://127.0.0.1:${server.address().port}`, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary,
    }, stdio:["ignore","pipe","pipe"]});
    let logs = "";
    child.stdout.on("data", part => { logs += part; });
    child.stderr.on("data", part => { logs += part; });
    const [exit] = await once(child, "close");
    const machine = readFileSync(outputs, "utf8");
    const step = readFileSync(summary, "utf8");
    for (const surface of [logs, machine, step, JSON.stringify(requests)]) {
      assert.ok(!surface.includes(marker), "private marker appeared on an outbound surface");
    }
    assert.equal(requests.length, 1);
    return { exit, logs, machine, step };
  } finally {
    if (server.listening) await new Promise(done => server.close(done));
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("reviewer, reason, configured path and raw event text stay local for an acknowledged event", async () => {
  const result = await check([knownEvent], [review]);
  assert.equal(result.exit, 0);
  assert.match(result.machine, /^acknowledged=1$/m);
  assert.match(result.step, /maintainer changed/);
  assert.match(result.logs, /acknowledged/);
});

test("unknown labels and unrecognized IDs are withheld while valid events remain actionable", async () => {
  const result = await check([
    { ...knownEvent, eventId: marker + "-id", type: marker + "-kind" },
    { ...knownEvent, type: marker + "-other" },
  ], []);
  assert.equal(result.exit, 1);
  assert.match(result.machine, /^events=2$/m);
  assert.match(result.logs, new RegExp('"eventId":"' + id + '"'));
  assert.match(result.step, /change/);
});

test("a mismatched review never prints the configured name or the configured type", async () => {
  for (const entry of [{ ...review, package: "@" + marker + "/lib" }, { ...review, type: marker + "-kind" }]) {
    const result = await check([knownEvent], [entry]);
    assert.equal(result.exit, 1);
    assert.match(result.logs, /differs from the event/);
    assert.match(result.machine, /^acknowledged=0$/m);
  }
});

test("malformed JSON and rejected rows produce generic diagnostics without file contents or path", async () => {
  for (const data of [marker, [null, { reviewedBy: marker }], '{"reviewed":false}']) {
    const result = await check([knownEvent], data);
    assert.equal(result.exit, 1);
    assert.match(result.logs, /allowlist/);
    assert.match(result.machine, /^acknowledged=0$/m);
  }
});
