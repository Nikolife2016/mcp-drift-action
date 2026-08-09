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

function autodetect() {
  const found = new Set(fromPackageJson("."));
  for (const f of MCP_CONFIGS) if (existsSync(f)) fromMcpConfig(f).forEach(x => found.add(x));
  // Монорепозитории: пакеты часто лежат в packages/*/package.json
  for (const dir of ["packages", "apps"]) {
    if (!existsSync(dir)) continue;
    try {
      for (const sub of readdirSync(dir)) fromPackageJson(join(dir, sub)).forEach(x => found.add(x));
    } catch { /* нечитаемый подкаталог не должен ронять шаг */ }
  }
  return [...found];
}

// ── проверка ───────────────────────────────────────────────────────────────
const manual = (process.env.INPUT_PACKAGES || "").split(",").map(s => s.trim()).filter(Boolean);
const packages = manual.length ? manual : autodetect();

if (!packages.length) {
  console.log("MCP Drift Check: no packages found to check (no package.json, no MCP config). Nothing to do.");
  out("events", 0); out("high", 0);
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
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`${API} answered ${r.status}`);
    const j = await r.json();
    events.push(...(j.events || []));
  }
} catch (e) {
  // Недоступность нашего сервиса — не повод рушить чужую сборку. Мы говорим об этом вслух
  // и выходим успешно: ложно-красный CI отключают первым же коммитом, и проверки не станет.
  console.log(`MCP Drift Check: could not reach PulseFeed (${e.message}). Skipping without failing the build.`);
  out("events", 0); out("high", 0);
  process.exit(0);
}

const bySev = { high: 0, medium: 0, low: 0 };
for (const e of events) bySev[e.severity] = (bySev[e.severity] || 0) + 1;

console.log(`MCP Drift Check — ${packages.length} package(s), last ${DAYS} days.`);
if (!events.length) {
  console.log("No recorded drift. Nothing changed dangerously in what this repo depends on.");
  out("events", 0); out("high", 0);
  process.exit(0);
}

// В логе показываем medium и выше. Событие `version_published` — это просто «вышел релиз»,
// и в CI, который смотрят между делом, три строки про новые версии прячут одну строку про
// исчезнувший репозиторий. Счётчик отдаём отдельно, полная выдача — в JSON и в фиде.
const ICON = { high: "🔴", medium: "🟡", low: "⚪" };
const notable = events.filter(e => SEV_RANK[e.severity] >= SEV_RANK.medium);
if (!notable.length) {
  console.log(`No notable drift. (${events.length} routine version update(s) in the window.)`);
  out("events", 0); out("high", 0);
  process.exit(0);
}
if (events.length > notable.length) {
  console.log(`(${events.length - notable.length} routine version update(s) not shown.)`);
}
for (const e of notable.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])) {
  const vers = e.prevVersion && e.version && e.prevVersion !== e.version ? ` (${e.prevVersion} → ${e.version})` : "";
  console.log(`${ICON[e.severity] || "•"} ${e.id}${vers}: ${e.headline}`);
  console.log(`   ${API}/mcp/s/${encodeURIComponent(e.id)}`);
}

// Сводка в GitHub Job Summary — её видно, не разворачивая логи.
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const rows = notable.map(e => `| ${e.severity} | \`${e.id}\` | ${e.type.replace(/_/g, " ")} | ${e.headline} |`).join("\n");
  try {
    appendFileSync(summary,
      `## MCP Drift Check\n\n${notable.length} notable change(s) recorded in the last ${DAYS} days across ${packages.length} dependencies.\n\n` +
      `| severity | package | what | detail |\n|---|---|---|---|\n${rows}\n\n` +
      `Full feed: ${API}/mcp/drift\n`);
  } catch { /* сводка необязательна */ }
}

out("events", notable.length);
out("high", bySev.high || 0);

function out(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) { try { appendFileSync(f, `${name}=${value}\n`); } catch { /* не критично */ } }
}

if (FAIL_ON !== "never" && SEV_RANK[FAIL_ON] && notable.some(e => SEV_RANK[e.severity] >= SEV_RANK[FAIL_ON])) {
  console.log(`\nFailing the build: fail-on is "${FAIL_ON}".`);
  process.exit(1);
}
