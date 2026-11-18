// MCP Drift Check — шаг CI, который спрашивает у PulseFeed: не изменилось ли что-то опасное
// в пакетах, которым этот репозиторий уже доверяет.
//
// Зачем отдельно от `npm audit` и сканеров: они отвечают на вопрос «есть ли известная дыра
// сегодня». Здесь другой вопрос — «что поменялось с тех пор, как это поставили»: появился ли
// install-скрипт, которого не было при ревью, сменился ли владелец пакета, исчез ли репозиторий.
// Rug pull проходит мимо статической проверки по определению: на момент проверки код был чист.
//
// Ноль зависимостей, запросы пакетами, без ключа. Node 18+ (есть в раннерах GitHub).
import { readFileSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const API = (process.env.INPUT_API || "https://pulsefeed.dev").replace(/\/+$/, "");
const DAYS = Math.max(1, Math.min(365, Number(process.env.INPUT_DAYS) || 30));
const FAIL_ON = (process.env.INPUT_FAIL_ON || "never").trim().toLowerCase();
const ALLOWLIST = process.env.INPUT_ALLOWLIST || ".mcp-drift-allowlist.json";

const SELF_CHECK = process.env.PULSEFEED_SELF_CHECK === "true";

const SEV_RANK = { high: 3, medium: 2, low: 1 };

// ── откуда берём список пакетов ────────────────────────────────────────────
// Явный список пакетов имеет приоритет. Поиск в репозитории включается через share-discovered.
const MCP_CONFIGS = [
  ".mcp.json", "mcp.json",
  ".cursor/mcp.json", ".vscode/mcp.json",
  "claude_desktop_config.json", ".claude/settings.json", ".claude/settings.local.json",
];

function fromPackageJson(dir) {
  const p = join(dir, "package.json");
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return [...Object.keys(j.dependencies || {}), ...Object.keys(j.devDependencies || {})];
  } catch { return []; }
}

// MCP-серверы обычно объявлены как `npx -y <пакет>` или `command: npx, args: [-y, <пакет>]`.
// Вытаскиваем имя пакета из обеих форм, отбрасывая флаги и версии.
function fromMcpConfig(file) {
  let j;
  try { j = JSON.parse(readFileSync(file, "utf8")); } catch { return []; }
  const out = new Set();
  const servers = j.mcpServers || j.servers || {};
  for (const s of Object.values(servers)) {
    if (!s || typeof s !== "object") continue;
    const args = Array.isArray(s.args) ? s.args : [];
    const cmd = String(s.command || "");
    const words = [...cmd.trim().split(/\s+/), ...args.map(String)];
    const launcher = words.shift();
    if (!["npx", "bunx", "npm"].includes(launcher)) continue;
    if (launcher === "npm" && words.shift() !== "exec") continue;
    while (["-y", "--yes", "--"].includes(words[0])) words.shift();
    // Ignore commands with unfamiliar options rather than transmitting an option value.
    const pkg = /^(?:(@[a-z0-9][a-z0-9._~-]*\/)?([a-z0-9][a-z0-9._~-]*))(?:@[a-z0-9_.~^*-]+)?$/i.exec(words[0] ?? "");
    if (pkg) out.add((pkg[1] || "") + pkg[2]);
  }
  return [...out];
}

const SKIP_DIRS = new Set([".git", "node_modules", ".github", "dist", "build", "coverage", "vendor", ".next", ".venv"]);

function autodetect() {
  const found = new Set(fromPackageJson("."));
  for (const f of MCP_CONFIGS) if (existsSync(f)) fromMcpConfig(f).forEach(x => found.add(x));

  // Подкаталоги первого уровня целиком, а не только packages/ и apps/. Проверено на нашем
  // собственном репозитории: package.json лежал в mcp/, автодетект нашёл ноль пакетов и шаг
  // отрапортовал «нечего проверять» — то есть тихо не сделал ничего. Раскладка «пакет в
  // подкаталоге» слишком обычна, чтобы требовать от человека перечислять имена руками.
  let dirs = [];
  try { dirs = readdirSync(".", { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { /* корень нечитаем */ }
  for (const dir of dirs) {
    if (SKIP_DIRS.has(dir) || dir.startsWith(".")) continue;
    fromPackageJson(dir).forEach(x => found.add(x));
    // Ещё уровень вглубь: monorepo обычно packages/<name>/package.json
    try {
      for (const sub of readdirSync(dir, { withFileTypes: true })) {
        if (!sub.isDirectory() || SKIP_DIRS.has(sub.name)) continue;
        fromPackageJson(join(dir, sub.name)).forEach(x => found.add(x));
      }
    } catch { /* нечитаемый подкаталог не должен ронять шаг */ }
  }
  return [...found];
}

// ── подтверждённые события ─────────────────────────────────────────────────
// Первое настоящее срабатывание (19.09.2026, @modelcontextprotocol/sdk потерял сопровождающего)
// показало пробел: сборка красная 30 дней, пока событие не выйдет из окна, и единственный выход —
// снять проверку. Поэтому есть файл подтверждений. Подтверждается СОБЫТИЕ, а не пакет: ключ —
// eventId, содержательный хеш события из ленты; новая смена на том же пакете снова уронит сборку.
// Запись обязана назвать, кто, когда и почему. Нечитаемый файл = подтверждений нет: ошибка
// должна вести в красное, а не в зелёное.
function loadAllowlist(file) {
  if (!existsSync(file)) return { entries: new Map(), note: null };
  let j;
  try { j = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { return { entries: new Map(), note: `allowlist ${file} is not valid JSON (${e.message}); treating as empty` }; }
  const list = Array.isArray(j) ? j : Array.isArray(j?.reviewed) ? j.reviewed : null;
  if (!list) return { entries: new Map(), note: `allowlist ${file} must be {"reviewed": [...]}; treating as empty` };
  const entries = new Map(); const bad = [];
  list.forEach((r, i) => {
    const ok = r && typeof r === "object"
      && /^[0-9a-f]{16}$/.test(String(r.eventId || ""))
      && typeof r.reviewedBy === "string" && r.reviewedBy.trim()
      && typeof r.reviewedAt === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.reviewedAt)
      && typeof r.reason === "string" && r.reason.trim();
    if (ok) entries.set(r.eventId, r); else bad.push(i);
  });
  const note = bad.length ? `allowlist ${file}: ${bad.length} entr${bad.length === 1 ? "y" : "ies"} ignored (index ${bad.join(", ")}) — each needs eventId (16 hex), reviewedBy, reviewedAt (YYYY-MM-DD) and reason` : null;
  return { entries, note };
}

// Подтверждение действует, только если названные в нём пакет и тип совпадают с событием —
// защита от вставки чужого id. Возвращает запись или причину отказа.
function acknowledgement(e, entries) {
  if (!e.eventId) return { entry: null, why: "event carries no eventId (feed too old to acknowledge)" };
  const r = entries.get(e.eventId);
  if (!r) return { entry: null, why: null };
  if (r.package && r.package !== e.id) return { entry: null, why: `acknowledgement ${e.eventId} names package ${r.package}, but the event is on ${e.id} — ignored` };
  if (r.type && r.type !== e.type) return { entry: null, why: `acknowledgement ${e.eventId} names type ${r.type}, but the event is ${e.type} — ignored` };
  return { entry: r, why: null };
}

// ── проверка ───────────────────────────────────────────────────────────────
const manual = (process.env.INPUT_PACKAGES || "").split(",").map(s => s.trim()).filter(Boolean);
// Discovery from the workspace can include private package names. Sharing is opt-in.
const shareDiscovered = process.env.INPUT_SHARE_DISCOVERED === "true";
const candidates = manual.length ? manual : (shareDiscovered ? autodetect() : []);
const npmName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const packages = [...new Set(candidates.filter(name => name.length <= 214 && npmName.test(name)))];

const invalid = new Set(candidates.filter(name => name.length > 214 || !npmName.test(name))).size;
const validPolicy = ["never", "high", "medium"].includes(FAIL_ON);
const events = [];
const observed = new Set();
let goodBatches = 0;
let sourceError = false;
let incomplete = false;
let sourcesIncomplete = false;
let truncated = false;
if (!validPolicy) console.log("Invalid fail-on policy. Choose never, medium or high.");
if (!packages.length) console.log("No approved package names to check. Supply packages or explicitly enable share-discovered.");

// Keep both the API's 200-name limit and a bounded request target for scoped npm names.
const batches = [];
let batch = [];
let encodedLength = 0;
for (const name of packages) {
  const length = encodeURIComponent(name).length;
  if (batch.length === 200 || encodedLength + length + 3 > 6000) {
    batches.push(batch);
    batch = [];
    encodedLength = 0;
  }
  encodedLength += length + (batch.length ? 3 : 0);
  batch.push(name);
}
if (batch.length) batches.push(batch);
for (const c of validPolicy ? batches : []) {
  try {
    const url = `${API}/mcp/drift.json?days=${DAYS}&packages=${encodeURIComponent(c.join(","))}`;
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });   // зависшая сеть не должна держать шаг вечно
    if (!r.ok) throw new Error(`${API} answered ${r.status}`);
    const j = await r.json();
    if ((SELF_CHECK || j?.requested !== undefined) &&
        (!Array.isArray(j?.requested) || j.requested.length !== c.length || !c.every(pkg => j.requested.includes(pkg)))) {
      throw new Error("response does not confirm the requested packages");
    }
    if (!Array.isArray(j?.events) || !j.events.every(e => e && c.includes(e.id)
      && Object.hasOwn(SEV_RANK, e.severity) && typeof e.type === "string" && typeof e.headline === "string")) {
      throw new Error("invalid events in drift response");
    }
    if (j.total !== undefined && (!Number.isSafeInteger(j.total) || j.total < j.events.length)) {
      throw new Error("invalid total in drift response");
    }
    if (j.windowDays !== undefined && j.windowDays !== DAYS) throw new Error("unexpected response window");
    if (j.coverage !== undefined) {
      if (!Array.isArray(j.coverage?.observed) || !j.coverage.observed.every(pkg => c.includes(pkg))
        || typeof j.coverage.sourcesComplete !== "boolean") throw new Error("invalid coverage in drift response");
      for (const pkg of j.coverage.observed) observed.add(pkg);
      if (!j.coverage.sourcesComplete) sourcesIncomplete = true;
    } else {
      incomplete = true;
    }
    if (j.total === undefined || j.requested === undefined) incomplete = true;
    if (j.total > j.events.length) truncated = true;
    goodBatches++;
    for (const event of j.events) observed.add(event.id);
    events.push(...j.events);
  } catch (error) {
    sourceError = true;
    incomplete = true;
    console.log("MCP Drift Check: scoped feed unavailable or invalid for one batch.");
  }
}

const unknown = packages.length + invalid - observed.size;
let coverageStatus;
if (!batches.length || !validPolicy) coverageStatus = "not_checked";
else if (!goodBatches) coverageStatus = "unavailable";
else if (sourceError || sourcesIncomplete || truncated) coverageStatus = "partial";
else if (!observed.size) coverageStatus = "unknown";
else if (unknown || incomplete) coverageStatus = "partial";
else coverageStatus = "complete";

console.log(`MCP Drift Check — ${packages.length} package(s), last ${DAYS} days.`);
const allow = loadAllowlist(ALLOWLIST);
if (allow.note) console.log(`⚠️  ${allow.note}`);
const ICON = { high: "🔴", medium: "🟡", low: "⚪" };
const notable = events.filter(e => SEV_RANK[e.severity] >= SEV_RANK.medium);
const routine = events.length - notable.length;
if (!events.length) console.log("No events returned in the requested window.");
if (routine && !notable.length) console.log(`No notable drift in the returned events. (${routine} routine change(s).)`);
if (routine && notable.length) console.log(`(${routine} routine change(s) not shown.)`);
// Делим на открытые и подтверждённые. Подтверждённые печатаются — их не прячут, — но не роняют сборку.
const open = [], acked = [];
for (const e of notable.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])) {
  const a = acknowledgement(e, allow.entries);
  if (a.why) console.log(`⚠️  ${a.why}`);
  (a.entry ? acked : open).push([e, a.entry]);
}
for (const [e] of open) {
  const vers = e.prevVersion && e.version && e.prevVersion !== e.version ? ` (${e.prevVersion} → ${e.version})` : "";
  console.log(`${ICON[e.severity] || "•"} ${e.id}${vers}: ${e.headline}`);
  console.log(`   ${API}/mcp/s/${encodeURIComponent(e.id)}`);
}
for (const [e, r] of acked) {
  console.log(`✅ ${e.id}: ${e.type.replace(/_/g, " ")} — acknowledged by ${r.reviewedBy} on ${r.reviewedAt.slice(0, 10)}: ${r.reason}`);
}

const statusByCoverage = {
  complete: "no_notable_events", partial: "partial", unknown: "unknown_coverage",
  unavailable: "unavailable", not_checked: "not_checked",
};
const checkStatus = notable.length ? "notable" : statusByCoverage[coverageStatus];
const outputs = {
  check_status: checkStatus, coverage_status: coverageStatus, coverage_complete: coverageStatus === "complete",
  covered: observed.size, unknown, source_error: sourceError, invalid_inputs: invalid, truncated,
  events: open.length, high: open.filter(([e]) => e.severity === "high").length,
  acknowledged: acked.length, routine, notable: notable.length, baseline_status: "unknown",
  fail_on: validPolicy ? FAIL_ON : "invalid",
};
if (process.env.GITHUB_OUTPUT) {
  const records = Object.entries(outputs).map(([name, value]) => `${name}=${value}\n`).join("");
  try { appendFileSync(process.env.GITHUB_OUTPUT, records); }
  catch {
    console.error("MCP Drift Check: could not write GITHUB_OUTPUT; machine results could not be delivered to the runner.");
    process.exitCode = 1;
  }
}
console.log(`Drift check: ${checkStatus}; coverage: ${coverageStatus}; observed: ${observed.size}; without evidence: ${unknown}; source error: ${sourceError}; truncated: ${truncated}; fail-on: ${outputs.fail_on}.`);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  // Text in the table comes from the API and the allowlist. Keep it inside its cell.
  const cell = value => String(value).replace(/[\r\n\t]+/g, " ").replace(/[&<>|\\`{}[\]()!*_~]/g, c => `&#${c.charCodeAt(0)};`);
  const detail = [...open.map(([e]) => [e, "open"]),
    ...acked.map(([e, r]) => [e, `acknowledged by ${r.reviewedBy} (${r.reviewedAt.slice(0, 10)})`])];
  const rows = detail.map(([e, decision]) =>
    "| " + [e.severity, e.id, e.type.replace(/_/g, " "), e.headline, decision].map(cell).join(" | ") + " |");
  const lines = ["## MCP Drift Check", "",
    `Result: **${checkStatus}**. Coverage: **${coverageStatus}**. Client adoption baseline: **${outputs.baseline_status}**. Event failure threshold: **${outputs.fail_on}**.`,
    `Observed packages: ${observed.size}. Without evidence: ${unknown}. Invalid names: ${invalid}. Source error: ${sourceError}. Truncated: ${truncated}.`,
    `Returned changes: ${routine} routine, ${open.length} open notable, ${acked.length} acknowledged notable.`];
  if (rows.length) lines.push("", "| Severity | Package | Change | Detail | Status |", "|---|---|---|---|---|", ...rows);
  try { appendFileSync(summary, lines.join("\n") + "\n"); } catch { /* optional summary */ }
}

if (!validPolicy || (SELF_CHECK && (sourceError || sourcesIncomplete || coverageStatus === "not_checked"))) process.exitCode = 1;
const failing = validPolicy && FAIL_ON !== "never" ? open.filter(([e]) => SEV_RANK[e.severity] >= SEV_RANK[FAIL_ON]) : [];
if (failing.length) {
  console.log(`\nFailing the build: fail-on is "${FAIL_ON}".`);
  // Готовый к вставке фрагмент: подтверждение — это решение человека после проверки, и путь к
  // нему должен быть короче, чем путь к снятию проверки.
  console.log(`\nIf you have reviewed ${failing.length === 1 ? "this change" : "these changes"} and accept ${failing.length === 1 ? "it" : "them"}, add to ${ALLOWLIST} (the build stays red for anything not listed, and for any new event on the same package):`);
  const today = new Date().toISOString().slice(0, 10);
  const snippet = failing.filter(([e]) => e.eventId).map(([e]) => JSON.stringify({ eventId: e.eventId, package: e.id, type: e.type, reviewedBy: "<your name>", reviewedAt: today, reason: "<why this change is acceptable>" }));
  if (snippet.length) console.log(`{ "reviewed": [\n  ${snippet.join(",\n  ")}\n] }`);
  process.exit(1);
}
