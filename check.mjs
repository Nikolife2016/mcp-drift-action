// MCP Drift Check — шаг CI, который спрашивает у PulseFeed: не изменилось ли что-то опасное
// в пакетах, которым этот репозиторий уже доверяет.
//
// Зачем отдельно от `npm audit` и сканеров: они отвечают на вопрос «есть ли известная дыра
// сегодня». Здесь другой вопрос — «что поменялось с тех пор, как это поставили»: появился ли
// install-скрипт, которого не было при ревью, сменился ли владелец пакета, исчез ли репозиторий.
// Rug pull проходит мимо статической проверки по определению: на момент проверки код был чист.
//
// Ноль зависимостей, один HTTP-запрос, без ключа. Node 18+ (есть в раннерах GitHub).
import { readFileSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const API = (process.env.INPUT_API || "https://pulsefeed.dev").replace(/\/+$/, "");
const DAYS = Math.max(1, Math.min(365, Number(process.env.INPUT_DAYS) || 30));
const FAIL_ON = (process.env.INPUT_FAIL_ON || "high").toLowerCase();
const ALLOWLIST = process.env.INPUT_ALLOWLIST || ".mcp-drift-allowlist.json";

const SEV_RANK = { high: 3, medium: 2, low: 1 };

// ── откуда берём список пакетов ────────────────────────────────────────────
// Пользователь может перечислить руками, но почти никто не станет: список зависимостей
// живёт в файлах и меняется. Поэтому по умолчанию читаем то, что и так лежит в репозитории.
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
    const parts = [...cmd.split(/\s+/), ...args.map(String)];
    for (const raw of parts) {
      const t = raw.trim();
      if (!t || t.startsWith("-")) continue;
      if (/^(npx|node|npm|bunx|uvx|python3?|deno)$/.test(t)) continue;
      if (t.startsWith("/") || t.startsWith(".")) continue;   // локальный путь, не пакет
      // @scope/name или name, возможно с @version — версию отрезаем
      const m = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?([a-z0-9-~][a-z0-9-._~]*)/i.exec(t);
      if (m) out.add((m[1] || "") + m[2]);
      break;   // первый не-флаг после команды и есть пакет
    }
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
const packages = manual.length ? manual : autodetect();

if (!packages.length) {
  console.log("MCP Drift Check: no packages found to check (no package.json, no MCP config). Nothing to do.");
  out("events", 0); out("high", 0); out("acknowledged", 0);
  process.exit(0);
}

// Ограничение API — 200 имён на запрос; режем на пачки, чтобы монорепозиторий не обрезался молча.
const CHUNK = 200;
const chunks = [];
for (let i = 0; i < packages.length; i += CHUNK) chunks.push(packages.slice(i, i + CHUNK));

let events = [];
try {
  for (const c of chunks) {
    const url = `${API}/mcp/drift.json?days=${DAYS}&packages=${encodeURIComponent(c.join(","))}`;
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });   // зависшая сеть не должна держать шаг вечно
    if (!r.ok) throw new Error(`${API} answered ${r.status}`);
    const j = await r.json();
    events.push(...(j.events || []));
  }
} catch (e) {
  // Недоступность нашего сервиса — не повод рушить чужую сборку. Мы говорим об этом вслух
  // и выходим успешно: ложно-красный CI отключают первым же коммитом, и проверки не станет.
  console.log(`MCP Drift Check: could not reach PulseFeed (${e.message}). Skipping without failing the build.`);
  out("events", 0); out("high", 0); out("acknowledged", 0);
  process.exit(0);
}

const bySev = { high: 0, medium: 0, low: 0 };
for (const e of events) bySev[e.severity] = (bySev[e.severity] || 0) + 1;

console.log(`MCP Drift Check — ${packages.length} package(s), last ${DAYS} days.`);
const allow = loadAllowlist(ALLOWLIST);
if (allow.note) console.log(`⚠️  ${allow.note}`);
if (!events.length) {
  console.log("No recorded drift. Nothing changed dangerously in what this repo depends on.");
  out("events", 0); out("high", 0); out("acknowledged", 0);
  process.exit(0);
}

// В логе показываем medium и выше. Событие `version_published` — это просто «вышел релиз»,
// и в CI, который смотрят между делом, три строки про новые версии прячут одну строку про
// исчезнувший репозиторий. Счётчик отдаём отдельно, полная выдача — в JSON и в фиде.
const ICON = { high: "🔴", medium: "🟡", low: "⚪" };
const notable = events.filter(e => SEV_RANK[e.severity] >= SEV_RANK.medium);
if (!notable.length) {
  console.log(`No notable drift. (${events.length} routine version update(s) in the window.)`);
  out("events", 0); out("high", 0); out("acknowledged", 0);
  process.exit(0);
}
if (events.length > notable.length) {
  console.log(`(${events.length - notable.length} routine version update(s) not shown.)`);
}
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

// Сводка в GitHub Job Summary — её видно, не разворачивая логи.
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const rows = [...open.map(([e]) => `| ${e.severity} | \`${e.id}\` | ${e.type.replace(/_/g, " ")} | ${e.headline} | open |`),
                ...acked.map(([e, r]) => `| ${e.severity} | \`${e.id}\` | ${e.type.replace(/_/g, " ")} | ${e.headline} | acknowledged by ${r.reviewedBy} (${r.reviewedAt.slice(0, 10)}) |`)].join("\n");
  try {
    appendFileSync(summary,
      `## MCP Drift Check\n\n${notable.length} notable change(s) recorded in the last ${DAYS} days across ${packages.length} dependencies; ${open.length} open, ${acked.length} acknowledged.\n\n` +
      `| severity | package | what | detail | status |\n|---|---|---|---|---|\n${rows}\n\n` +
      `Full feed: ${API}/mcp/drift\n`);
  } catch { /* сводка необязательна */ }
}

// Выходы считают ОТКРЫТОЕ — то, что требует внимания. Подтверждённое — отдельным числом.
out("events", open.length);
out("high", open.filter(([e]) => e.severity === "high").length);
out("acknowledged", acked.length);

function out(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) { try { appendFileSync(f, `${name}=${value}\n`); } catch { /* не критично */ } }
}

const failing = FAIL_ON !== "never" && SEV_RANK[FAIL_ON] ? open.filter(([e]) => SEV_RANK[e.severity] >= SEV_RANK[FAIL_ON]) : [];
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
