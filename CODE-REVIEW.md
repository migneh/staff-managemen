# 🔍 Repo Review — Staff Manager Bot (`migneh/staff-managemen`)

**Reviewed commit:** `420ada4` (branch `arena/01a0b61c-staff-managemen`)
**Scope:** every file in `src/`, `tests/`, plus config, packaging and docs (5,814 lines of JS — 5,430 in `src/`, 384 in `tests/` — 53 slash commands, 72 registered component handlers, 21 SQLite tables).
**Method:** full static read + dynamic checks (test run, settings/DB probes, command & component inventory, unused-import scan). Everything below was verified in this repo — repro commands are in [Appendix B](#appendix-b--how-to-reproduce).

> ## ✅ حالة الإصلاحات (2026-09-18)
>
> **كل ما في هذا التقرير من أخطاء صلاحيات وتواريخ وقياس أُصلح في الإصدار 1.1.0** —
> راجع [`CHANGELOG.md`](./CHANGELOG.md). أبرزها: فرض مركزي لصلاحيات 84 مكوّناً،
> توحيد التواريخ في `src/clock.js`، تفعيل أوزان القنوات في Score، إصلاح Leaderboard،
> إلغاء الخصم التلقائي، ونصاب موافقات الترقية. يبقى هذا التقرير مرجعاً لما كان،
> والبنود التي لم تُنفَّذ بعد (مثل لوحة ويب، ومراجعة الفهارس مع حجم بيانات كبير)
> موصوفة كما هي أدناه.

---

## Verdict at a glance

The project is genuinely well-built for its size: clear service/command split, i18n-in-one-language consistency, Arabic UX that is far above average (progress bars, coverage bars, relative Discord timestamps, empty states), migrations that don't destroy old data, and a real test suite that passes.

| Area | Rating | Notes |
|---|---|---|
| Product / UX | 🟢 Strong | Richer than most staff-management bots |
| Data model | 🟢 Good | Sensible schema, lazy migrations, WAL |
| Security / authz | 🔴 Needs work | Command-level checks are good, **component-level checks are inconsistent** |
| Correctness | 🟡 Fair | Timezone/date handling is wrong for the scheduled jobs; several dead code paths |
| Performance | 🟡 Fair | ~4–5 synchronous DB statements per staff message; N+1 in reports |
| Tests / CI | 🟠 Weak | 21 tests, services only, no CI, no lint, no command-layer tests |
| Docs / repo hygiene | 🟡 Fair | Excellent README for features, but command list has drifted; no LICENSE/CI |

**Test run in this sandbox:** `npm install --ignore-scripts` → `npm test` → **21 pass / 0 fail** (12 suites, 481 ms).
(`better-sqlite3` cannot compile here because `nodejs.org` is unreachable; `tests/sqlite-compat.js` shims it via `node:sqlite`. On a normal machine plain `npm install` works.)

**TL;DR (العربية):** الأساس قوي والمنطق منظم، لكن هناك ثغرة صلاحيات في أزرار المكوّنات (`promo:reject` بلا فحص مستوى)، وخطأ توقيت يجعل مهام الإجازات/الاستقالات الليلية تعمل بيوم سابق (UTC مقابل `TZ`)، وانعدام مسار إلغاء الإيقاف، وغياب CI/lint. أهم 10 إصلاحات في أعلى التقرير.

---

## 🚨 Top 10 priorities

| # | Prio | Finding | Where |
|---|---|---|---|
| 1 | **P0** | Component handlers bypass command-level authorization — reachable today: `promo:reject`(→`promo:rejectmodal`), `faq:hist`, `leave:details` | `src/index.js:137`, `src/commands/promotions.js:122` |
| 2 | **P0** | `/log-ticket` awards points to any user id → trivially inflatable promotion points | `src/commands/logging.js:78-90` |
| 3 | **P0** | `suspended` status has no exit path — one click permanently locks a member | `src/commands/records.js:73`, `src/index.js:131` |
| 4 | **P1** | `settings.load()` JSON-parses DB values unguarded → one bad row bricks the bot (verified crash) | `src/services/settings.js:20` |
| 5 | **P1** | All date logic is UTC while cron runs in `TZ` → night jobs act on *yesterday*, reminders off by one | `src/utils.js:28-29`, `src/scheduler.js:282-288` |
| 6 | **P1** | No `GuildMemberRemove` / role-loss handling → left members stay "active" and get absence alerts forever | `src/index.js:83-90` |
| 7 | **P1** | No graceful shutdown / `client.on('error')` / `login().catch()` → silent death, unflushed WAL | `src/index.js:148-149` |
| 8 | **P2** | Per-message write amplification (~4–5 synchronous statements/message) + no statement caching | `src/index.js:66-80`, `src/services/activity.js:47`, `src/services/staff.js:69` |
| 9 | **P2** | Unbounded tables (`activity_logs`, `audit_logs`, `saved_reports`) — no retention job | `src/database.js` |
| 10 | **P2** | No CI, no lint, no tests for the permission matrix or the command layer | repo root |

---

## 1. Security & authorization

### 1.1 🔴 Component handlers don't get the same authorization as commands

`src/index.js:121-134` enforces `cmd.level`, `cmd.maxLevel`, `cmd.team` and `serverManagerOnly` **only for `isChatInputCommand()`**. For buttons/selects/modals (`src/index.js:137-141`) the only check is "is this person some staff member (or Server Manager)".

```js
// src/index.js:137
if (i.isButton() || i.isAnySelectMenu() || i.isModalSubmit()) {
  const r = resolveComponent(i.customId);
  if (!r) return;
  return await r.handler(i, r.args);   // ← no level/team/ownership check here
}
```

Most sensitive handlers re-check `i.staffLevel` themselves — but not all. I scanned the source of all 72 handlers; "reachable" below means the button/modal actually ships on a **non-ephemeral** message posted by the bot:

| Handler | Gate | Reachable from a channel message? | Risk |
|---|---|---|---|
| `promo:approve` | ✅ `staffLevel < rule.approvalLevel` | yes | — (correct) |
| **`promo:reject` → `promo:rejectmodal`** | ❌ **none** | **yes** — `reviewRow()` is posted to `#manager-review` (`src/commands/promotions.js:96`) | Any staff who can see that channel can reject *any* pending promotion **and** set a 30-day cooldown on the applicant (`promotions.js:122-137`). Destructive and unapprovable. |
| **`faq:hist`** | ❌ none | **yes** — the button is attached to every FAQ entry embed, with the comment *"زر سريع لعرض السجل (للإدارة)"* (`faq.js:74,435`) | Any staff reading a public FAQ panel can view the revision history, including who edited/deleted what (`changed_by`, old versions). Contradicts its own comment. |
| **`leave:details`** | ❌ none | **yes** — on `#leave-requests` messages (`leaves.js:316`) | Full request details (reason, dates, coverage, gap analysis) for other members (`leaves.js:375`). |
| `leave:pending` | ❌ none | no (ephemeral-only nav) | Lists pending leave requests to whoever can trigger the id (`leaves.js:438`). |
| `modaction:log:<type>` | ❌ none | no (ephemeral from `/log-action`) | Doesn't verify the actor is on the moderation team — relies entirely on the *command*'s `team` gate (`logging.js:93`). One refactor away from a hole. |
| `ticket:log` | ❌ none | no (ephemeral) | See 1.2 — the real problem there is arbitrary `claimer`, not reachability. |
| `setup:*` | ✅ explicit Administrator gate (`index.js:99-103`) | — | — |

> Discord validates that a `custom_id` exists on a message the user can see, so this isn't "anyone on the internet" — but `#manager-review` / `#leave-requests` are commonly visible to the whole staff team (and the FAQ panel is visible to *everyone* on the server). A Helper clicking **رفض** is enough.

**Fix (recommended shape)** — make authorization declarative and enforce it in one place:

```js
// src/commands/index.js
for (const [id, h] of Object.entries(m.components || {})) {
  if (components.has(id)) throw new Error(`duplicate component id: ${id}`);
  components.set(id, { level: LEVELS.STAFF, team: null, handle: h, ...meta(id) });
}
```

```js
// src/index.js — after resolving the component
const gate = r.entry.level ?? 0;
const lvl  = i.staffLevel || (serverManager ? LEVELS.GENERAL_MANAGER : 0);
if (lvl < gate) return replyEphemeral(i, '❌ لا تملك هذه الصلاحية.', COLORS.danger);
if (r.entry.team && i.staffInfo?.team !== r.entry.team && !serverManager) return replyEphemeral(i, '❌ الأمر خاص بفريق آخر.', COLORS.danger);
return r.entry.handle(i, r.args);
```

Add a unit test that asserts **every** registered component declares an explicit level (default-deny), so no future handler can ship ungated.

### 1.2 🔴 `/log-ticket` can mint arbitrary points

`src/commands/logging.js:78-90` accepts a free-text `claimer` id and `saveTicket()` → `ticketLogs.recordTicket()` → `points.add(claimer, 'ticket_closed', …)`. Any member of the support team (a fresh **Helper** included — the command's gate is `level: LEVELS.STAFF, team: 'support'`) can type their own id, or a friend's, and add +2/+5 per fake ticket — with no cap, no approval and no "already logged" protection for manual entries (`source_message_id` is only set for auto-imported logs, `src/services/ticketLogs.js:119-122`). These points feed `promotions.evaluate()`, i.e. they convert directly into a promotion.

**Suggestions**
- Restrict `claimer` to `i.user.id` unless the actor is ≥ Supervisor (log the override in audit).
- Treat `source='manual'` rows as *provisional*: exclude them from `points.total()`/`score` until confirmed, or count them at reduced weight.
- Rate limit: max N manual tickets per user per day, and warn when the same `ticket_id` is logged twice (`reopened` is intentional, but a duplicate *manual* entry should at least be surfaced).
- Keep the audit entry — it's already good (`action: 'ticket_logged'`).

### 1.3 🔴 `suspended` is a one-way door

`src/commands/records.js:73` sets `status = 'suspended'` on a final warning. Grepping the whole repo, **nothing ever sets it back**:

```
src/commands/records.js:73   setStatus(user.id, 'suspended')   ← only writer
src/index.js:131             blocked command list
src/services/reports.js:37   excluded from leaderboard
```

The 60-day promotion cooldown expires, but the member stays blocked from every command forever (no `/unsuspend`). Fixes: add `/unsuspend` (Boss+), auto-expire via `promotion_cooldowns.until`, or store `suspended_until` and check it in `src/index.js`.

### 1.4 🟠 `settings.load()` crashes the whole process on a malformed value (verified)

```js
// src/services/settings.js:20
const kv = Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)]));
```

Probe result: `CRASH on settings.load(): SyntaxError - Unexpected token 'o', "not-json" is not valid JSON`. A single corrupted/legacy row (or a future hand-edited DB, or a value written by an older version) takes down every command, the scheduler and every message handler.

**Fix:** `safeParse` per row + drop-and-log the offending key, and keep a `schema_version` row for future migrations.

### 1.5 🟠 Silent fallback to `config.example.json` (fake ids) and unguarded config parse

`src/config.js:10-15` reads `config.json`, and if missing quietly loads `config.example.json` whose ids are the literal string `"ROLE_ID"`. `settings.load()` then strips those values (`settings.js:47-48`), so the bot starts looking "configured but empty" — a confusing first-run experience. Also `JSON.parse(fs.readFileSync(...))` is unguarded in both branches: a trailing comma in `config.json` crashes at require-time.

**Fix:** fail fast with a clear Arabic message (`❌ config.json تالف في السطر …`), or ignore the example file entirely and print "run /setup".

### 1.6 🟡 Smaller authz/robustness items

- `resolveComponent` (`src/commands/index.js:27-34`) does longest-prefix matching over `:`-split ids. It works today, but a future key like `leave` would swallow everything under `leave:`. Add a startup assertion that no key is a prefix of another.
- `src/commands/index.js:22` silently overwrites duplicate command names / component ids.
- `src/index.js:95` silently ignores interactions from other guilds (no reply) — fine, but log it once.
- Secrets: none committed (`.env` absent, `.env.example` empty) ✅.

---

## 2. Correctness

### 2.1 🟠 UTC vs `TZ`: the nightly jobs act on the wrong day

`src/scheduler.js:281-288` schedules with `{ timezone: process.env.TZ || 'Asia/Riyadh' }`, but every date helper is UTC:

```js
// src/utils.js:28-29
function nowIso() { return new Date().toISOString().replace('T',' ').slice(0,19); }  // UTC
function today()  { return new Date().toISOString().slice(0,10); }                    // UTC
```

Consequence: when `processLeaves` / `processResignations` fire at **00:05–00:20 Asia/Riyadh (21:05 UTC, previous day)**, `today()` still returns *yesterday*:

- a leave starting today is **not** activated, and is only activated by the next night's run → `in vacation` role granted ~24 h late (`src/scheduler.js:79-92`);
- "your leave starts tomorrow" reminders are sent on the day it starts (`scheduler.js:73`);
- a leave that ended yesterday is marked `ended` (and the role removed) a day late (`scheduler.js:98-107`);
- `pendingExpireDays`, `daysBetween(created, today())` expiry and the resignation reminders inherit the same one-day skew.

**Fix:** one helper, used everywhere:

```js
const TZ = process.env.TZ || 'Asia/Riyadh';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit' });
function today() { return dayFmt.format(new Date()); }          // YYYY-MM-DD in the server's TZ
function nowIso() {                                                // local wall-clock, stored as text
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, dateStyle:'short', timeStyle:'medium' }).format(new Date());
  return p; // "2026-09-18 23:05:00"
}
```
Then either keep storing UTC timestamps and only localize *dates*, or store local time consistently — but pick one and document it. (Scheduled jobs comparing `created_at >= datetime('now','-30 days')` in SQLite stay UTC, so date-only columns should be the only thing that changes.)

### 2.2 🟠 Dead / no-op code that hides intent

| Where | Code | Note |
|---|---|---|
| `src/scheduler.js:83` | `const shouldAdd = timing === 'at_start' ? true : true;` | always true |
| `src/scheduler.js:39` | `settings.load()?.guildId` | never exists — dead lookup |
| `src/scheduler.js:108-110` | `} else { /* مزامنة … */ }` | empty branch |
| `src/services/leaves.js:187` | `grantTiming === 'at_approval' ? start : start` | both branches identical → `role_grant_at` always = start |
| `src/commands/setup.js:265` | `return i.message?.edit ? null : null;` | after a modal submit the policies page is never refreshed (inconsistent with `setup:policies-reset` which calls `i.update(policiesPage())`) |
| `src/commands/resignations.js:112` | `dmEmbed.addFields && null;` | leftover |
| `src/commands/resignations.js:294` | `if (notice < policy.noticeDays) { }` | empty block, "we don't block, just warn" — make the warn explicit |
| `src/ui/kit.js:11` | `const AR_DIGITS = (n) => String(n);` | identity placeholder |
| `src/commands/records.js:15` | `\`📁 سجل <@${userId}>\`.replace('<@','').replace('>','')` | hack to dodge mention parsing; use `` `📁 سجل ${userId}` `` |

Also found by an automated unused-import scan: `backup.js:6 replyEphemeral`, `help.js:14 divider`, `leaves.js:6 LEAVE_GLOBAL`, `logging.js:8 staffService`, `setup.js:4 StringSelectMenuBuilder`, `setup.js:6 LEAVE_RULES, VACATION_ROLE_TIMING`, `services/leaves.js:5 LEAVE_GLOBAL`, `utils.js:3 config`.

### 2.3 🟡 Members who leave (or lose their roles) stay "active" forever

`src/index.js:83-90` only calls `staffService.ensure()` **when a staff role is still present**:

```js
if (newM.guild.id === config.guildId && (staffService.get(newM.id) || resolveStaff(newM))) {
  const info = resolveStaff(newM);
  if (info) staffService.ensure(newM);      // ← role removed ⇒ info === null ⇒ nothing happens
}
```

So demoting someone by hand, or them leaving the server, leaves `staff_members.status = 'active'` in the DB — they keep appearing in reports/absence alerts. There is also no `Events.GuildMemberRemove` handler.

**Fix:** on `resolveStaff(member) === null` for a known staff row → `status = 'removed'` (or `resigned`) + audit entry; add `GuildMemberRemove` for the same, plus an optional log line to `#staff-logs`.

### 2.4 🟡 Other correctness notes

- **Vacation-role sync is half-finished**: `src/services/leaves.js:207-223` — in the `at_start` branch, when the member shouldn't have the role now but has an approved future leave, the code tries to keep the role only if it's already present, wrapped in `try { ... } catch {}` with no fallback path. Reachable states are few, but this deserves a single explicit rule: *"role is on ⇔ ∃ approved leave covering today, OR (timing = at_approval ∧ ∃ approved leave)"*.
- **`promo:modal` has no duplicate-pending guard**: the slash command checks `promo.pendingRequest()` (`promotions.js:68`) but the modal handler (`:90`) only re-checks eligibility, so a fast double-submit can create two pending requests.
- **`staff.ensure()` mutates status in 3 places** (`staff.js:30-49`): new → `probation` (except GM), rank change → possibly `probation`, resigned → `active`. It works, but the state machine is implicit — extract `deriveStatus(prev, info)` with a comment table.
- **Points ledger pollution**: `resetForNewRank` writes a synthetic `rank_reset` row (`points.js:37-40`) whose `reason_key` isn't in `POINTS`, so `/promotion-status` history shows the raw key.
- **`utils.discordTs`/`discordTs(x,'d')`** duplicates `kit.tsDate`; lowercase `'d'` works but the mix means two date formats coexist in the UI.

---

## 3. Performance & scale

### 3.1 🟠 Write amplification on every staff message

Per message from a staff member (`src/index.js:66-80`) the bot issues, **synchronously**, roughly:

| Statement | Source |
|---|---|
| `SELECT * FROM staff_members` | `staffService.get()`/`ensure()` |
| `UPDATE staff_members SET last_activity …` | `staff.js:69` (unconditional, every message) |
| `SELECT 1 … content_hash` (duplicate check) | `activity.js:54` |
| `SELECT COUNT(*) … day` (general cap) | `activity.js:60` |
| `INSERT INTO activity_logs` | `activity.js:64` |

Also, `db.prepare()` is called on each invocation instead of caching statements (better-sqlite3 does not cache for you).

**Suggestions**
- Keep `last_activity` in memory (`Map<userId, ts>`) and flush to SQLite at most once every 60 s (or when it crosses the 72 h/96 h thresholds).
- Cache prepared statements at module scope (`const stmt = () => db.prepare(...)` memoized) — typically 20–30 % off hot paths.
- Collapse the dup-check + cap-check into one `SELECT COUNT(*) FILTER (…)` or a small in-memory ring buffer per user.
- Add `PRAGMA synchronous = NORMAL` (WAL already) and consider `db.pragma('cache_size = -8000')`.

### 3.2 🟡 N+1 queries in scheduled jobs and reports

- `src/services/leaves.js:165-178` `coverageBetween` runs `concurrentApproved()` **per boundary date** → up to 2·N queries per call; it's called from the leave modal and the coverage embed. One SQL can compute max overlap.
- `src/scheduler.js:70` awaits `guildMember(client, userId)` inside the per-request loops (→ `members.fetch()` per row, daily). Fetch once via `guild.members.fetch({ user: ids })` or use the cache.
- `src/services/reports.js:26-43` `team()`/`leaderboard()` call `individual()` per member, each running 6 queries (`score.monthlyRaw`). 50 staff → ~300 queries per report, and `weeklyReport` runs it twice plus a DM per member.
- `src/scheduler.js:228-247` calls `staffService.all()` three times in the same function.

### 3.3 🟡 Unbounded growth

`activity_logs` (one row per message!), `audit_logs`, `saved_reports` and `promotion_points` are never pruned, and `activity_logs` only has `idx_activity_user_day`. On an active server this file grows without limit.

- Add a monthly retention job: e.g. compress `activity_logs` older than 12 months into a `activity_daily` rollup (user_id, day, type, count, weight) and delete the raw rows.
- `CREATE INDEX idx_activity_created ON activity_logs(created_at)` for the retention scan (and for `stats()`).
- Add `VACUUM` (or `PRAGMA auto_vacuum=INCREMENTAL` + `incremental_vacuum`) after pruning.

---

## 4. Architecture & maintainability

1. **Business logic lives in command modules.** `resignations.js` (375 lines) does validation, DB writes, role surgery, DMs and embeds in one file; there is no `services/resignations.js` even though `services/leaves.js` exists. Extract per-domain services (`ask`/`decide`/`stats`) so the logic becomes unit-testable without Discord, and keep commands as thin adapters. Same for `faq.js` (566 lines: 2/3 UI).
2. **Command/component registry is implicit.** A hand-written `modules` array + 72 string keys + prefix matching. Move to `{ id, level, team, owner: 'self'|'staff', handle }` entries and enforce them centrally (see 1.1). Add a startup integrity check: unique ids, no prefix collisions, every command has `data.name === key`, every component has a level.
3. **Duplicated utilities**: `utils.progressBar` vs `kit.progressBar`; `utils.replyEphemeral` vs raw `i.reply`; `utils.discordTs` vs `kit.tsDate`; `userEmbed` vs `embed`. Pick `ui/kit.js` as the single source and have `utils` re-export (or delete the copies).
4. **Channel-key duplication**: the same list appears three times — `settings.js:128` (inside `status()`), `settings.js:147` (`CHANNEL_KEYS`), and `setup.js:10` (`CHANNEL_META` superset). Move to `constants.js` and derive.
5. **Magic numbers in code**: activity weights/caps are in constants ✅, but thresholds like 25/20/15/10 ladders (`score.js:11-15`), `'ticket-'` regex (`activity.js:17`), and role-name string literals (`'Support Office'`, `'Boss'`, `'Head Of Moderators'` in `setup.js:193`) are inline. Centralize.
6. **`src/index.js` is overloaded**: bootstrap + ticket-log importer + activity tracker + router. Extract `services/ticketImport.js` and `router.js`; you'll be able to unit-test the router (permissions!) without a Discord client.
7. **Comment/code drift**: `database.js:11` says `team TEXT -- support | moderation` but `general_management` is used; the README presents `config.json` as an optional fallback but never mentions that a missing file silently loads `config.example.json` with placeholder ids (→ 1.5).
8. **Error surface**: every failure ends in `console.error` (`index.js:143`, `utils.js:67`). Add a tiny logger (`level`, `scope`, optional file rotate) and mirror `error`-level entries to `#staff-logs` so admins see failures in Discord, not only in the terminal.

---

## 5. Testing & tooling

**What exists:** `tests/core.test.js` (289 lines, 21 assertions-grouped tests, 12 suites) covering spam filter, points/cooldowns, Score, promotions, FAQ + templates, leaves validation, resignation withdrawal, external ticket parsing, settings, onboarding tasks, component router. All green. `tests/sqlite-compat.js` is a clever fallback to `node:sqlite`.

**Gaps & recommendations**
1. **No test touches the command layer** — which is exactly where the authz bug lives. Add a table-driven test:
   ```js
   const matrix = [['promo:reject', LEVELS.MANAGEMENT], ['leave:approve', LEVELS.MANAGEMENT], …];
   for (const [id, need] of matrix) assert.ok(components.get(id).level >= need || manualCheck(id));
   ```
   plus a fake-interaction harness (`{ user, member, staffLevel, isButton: () => true, update/reply spies }`) to assert "Helper gets ❌, Manager gets ✅".
2. **No tests for `services/leaves.js` beyond validation**, none for `scheduler.js` (TZ bug would be caught by freezing the clock), none for `services/backup.js`.
3. **No coverage visibility**: `node --test --experimental-test-coverage`.
4. **No CI.** Add `.github/workflows/ci.yml`:
   ```yaml
   on: [push, pull_request]
   jobs: { test: { runs-on: ubuntu-latest, steps: [
     { uses: actions/checkout@v4 }, { uses: actions/setup-node@v4, with: { node-version: 22, cache: npm } },
     { run: npm ci --ignore-scripts }, { run: npm test }, { run: npx eslint src tests } ] } }
   ```
5. **No linter/formatter.** `npm i -D eslint prettier eslint-config-prettier`, `eslint:recommended` + `no-unused-vars` would have caught the 9 unused imports across 8 files (§2.2). Add `"lint"` and `"format"` scripts.
6. **`package.json` hygiene**: no `engines` field (Node ≥ 20 recommended; the test shim needs `node:sqlite` on Node 22+), no `files`, no `private: true`, no `lint` script, `version` stuck at 1.0.0.
7. **Native dependency risk**: `better-sqlite3` requires a compiler or a prebuild. Consider `engines.node >= 20` + a documented fallback, or migrate to `node:sqlite` (already used by the shim) once you're ready to drop Node < 22.

---

## 6. Docs & repo hygiene

- **README command table drifted.** Missing: `/leave-dashboard`, `/leave-coverage`, `/leave-history`, `/extend-leave`, `/my-resignations`, `/resignations-dashboard`, `/resignation-stats`, `/faq-panels`, `/faq-template-config`. (Verified against the live registry — 53 commands vs the ~44 documented.) Regenerate the table or add a `npm run docs:commands` script that prints it from the registry.
- **No `LICENSE`** although `package.json` says `ISC`; no `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, issue/PR templates, `.editorconfig`, `.nvmrc`, `.github/`.
- **No deployment docs**: a `systemd` unit (or Dockerfile + `docker-compose.yml` with a volume for `./data` and `./backups`) plus a *restore* procedure would prevent real pain. Document that `data/` is git-ignored and how to restore from `backups/`.
- **Permissions matrix** (which rank can do what, and which components are behind which level) is the doc users will ask for most — generate it from the registry once levels are declared (see 4.2).
- **FAQ content**: README documents the features well; consider a `docs/` folder for the long policy text instead of one giant README.

---

## 7. Ops & robustness

| Issue | Where | Suggestion |
|---|---|---|
| `client.login()` has no `.catch()`; an invalid token logs `unhandledRejection` and the process lingers | `index.js:148-149` | `client.login(token).catch(e => { console.error('❌ فشل تسجيل الدخول:', e.message); process.exit(1); })` |
| No `SIGINT`/`SIGTERM` handler | — | `const shutdown = () => { scheduler.stop?.(); client.destroy(); getDb().close(); process.exit(0); }` |
| No `client.on('error' | 'warn' | 'shardError')` | — | add handlers that log with a level and notify `#staff-logs` for `error` |
| Backup fallback copies the `.db` without `-wal` (possible torn snapshot) | `services/backup.js:13-14` | prefer `db.backup()` (already first choice) and drop the `copyFileSync` fallback, or use `db.exec("VACUUM INTO '…'")`; run `PRAGMA integrity_check` on the copy |
| No startup preflight | `index.js:27-42` | verify: bot's highest role > every configured staff role, `Manage Roles`/`Manage Channels`/`Send Messages` perms, required intents, channel existence; print a ✅/❌ checklist |
| Commands re-deployed on every boot | `index.js:31-36` | fine for a single guild; add a hash check and honor `SKIP_DEPLOY` in docs; catch 429 gracefully |
| Deleted/renamed configured channels fail silently | `utils.js:64-68` | on failure, clear the setting + notify `#staff-logs` |
| No health signal | — | add `/status` (uptime, DB size, last backup, scheduler last-run) for admins |
| `node-cron` jobs have no overlap guard | `scheduler.js:280-289` | `checkAbsence` on a big DB could exceed 30 min; add a `running` flag per job |

---

## 8. Product suggestions (beyond bugs)

1. **`/unsuspend` + suspension expiry** (see 1.3) — highest-value missing lifecycle command.
2. **Manual promotion override** (`/promote user: to:`) with mandatory reason + audit — today a Boss must edit the DB for special cases.
3. **Ticket reopen detection** from the external log (already emits `reopened` — surface it as an alert to `#ticket-logs` rather than only as −5 points).
4. **SLA/response alerts**: warn when a ticket is open > X hours with no claim (you already parse `duration`).
5. **Points ledger export** (`/export-points` → CSV) and a monthly per-member PDF-ready recap.
6. **Self-service `/me` improvements**: streak, rank progress toward the next promotion in %, "what's blocking me" — most of the data already exists in `promotions.evaluate`.
7. **Appeals flow** for warnings/notes (member → DM approval channel) — turns discipline into a two-way process.
8. **Leave calendar embed** (next 2 weeks, coverage bar per day) — `coverageBetween` already computes peak; a grid would prevent over-approval.
9. **Holiday/blackout calendar** (no leaves during launch weeks) — a policy key + a validation rule.
10. **Audit export & retention**: `/audit-export` + auto-prune older than N days, per data-protection norms.
11. **Configurable weights** for Score per rank (`score.js` ladders) from `/setup` — currently hardcoded and impossible to tune without a deploy.
12. **A11y/i18n structure**: extract user-visible strings to a single module to make wording changes safe (optional, low prio for a single-server bot).

---

## 9. Suggested roadmap

**Sprint 0 — quick wins (a few hours, low risk)**
1. Gate `promo:reject` / `promo:rejectmodal` / `faq:hist` / `leave:details` / `leave:pending` / `modaction:log` / `ticket:log` (direct checks today, declarative registry this week).
2. Wrap `settings.load()`'s `JSON.parse` in a safe parser.
3. `client.login().catch(process.exit(1))`, `SIGINT/SIGTERM`, `client.on('error')`.
4. Fix the 9 dead-code spots from §2.2 + remove the 9 unused imports in 8 files (eslint will keep them out).
5. `npm i -D eslint` + `.github/workflows/ci.yml` (test + lint).
6. Update the README command table (and add the missing `/…-dashboard` docs).

**Sprint 1 — correctness & lifecycle**
7. Timezone-correct `today()`/`nowIso()` + tests with a frozen clock.
8. `/unsuspend` + suspension expiry; `GuildMemberRemove` → `removed/resigned`.
9. Restrict manual ticket points (self-only for Helper+, audit overrides, daily cap).
10. Extract `services/resignations.js`; move embeds to `ui/`.

**Sprint 2 — performance & scale**
11. In-memory `last_activity` flush + cached prepared statements + `synchronous=NORMAL`.
12. Fix N+1s in `coverageBetween`, `reports.team/leaderboard`, and the scheduler member fetches.
13. Retention job + rollup table + `created_at` index (and a smaller DB in backups).

**Sprint 3 — polish**
14. `/status` preflight & health, error mirroring to `#staff-logs`, backup verification + restore docs.
15. Permission-matrix doc generated from the registry; `/promote`; appeals flow.

---

## Appendix A — inventory (verified from the live registry)

- **53 slash commands**, 13 modules; highest-privilege ones: `setup` (Administrator), `manage-general` + `backup` (`serverManagerOnly`), the `review-*` / `*-dashboard` / `audit-log` family (`MANAGEMENT`), `resign:accept` (`BOSS`).
- **72 component handlers**. The authorization scan above flags 19 handlers that *reference* `staffLevel` — but note `help:open`/`help:section` only use it to filter content, while `leave:approve/reject/rejectmodal/cancelquick/myleaves`, `resign:accept*/reject*/hold*/interview*`, `promo:approve` are real gates; and `setup:*` is gated centrally in `src/index.js`.
- **Sensitive handlers with no gate** (the 1.1 list): `promo:reject`, `promo:rejectmodal`, `faq:hist`, `leave:details`, `leave:pending`, `modaction:log`, `ticket:log`, and the `faq:cfg*` family (currently only reachable from management ephemeral payloads).
- **Schema**: 21 tables; only `ticket_metrics`, `faq_templates`, `faq_panels` and the two request tables have column-level migrations (`database.js:301-346`) — extend that pattern with `PRAGMA user_version` as you add fields.
- **Scheduled jobs**: absence (30 min), leaves (00:05), backup (00:15), resignations (00:20), daily (09:00), weekly (Fri 10:00), monthly (1st 11:00) — all in `TZ`.

## Appendix B — how to reproduce

```bash
npm install --ignore-scripts          # skip native build in sandboxes; plain npm install elsewhere
npm test                              # 21 pass / 0 fail (12 suites)

# inventory + authz scan
node -e "const{commands,components}=require('./src/commands');console.log(commands.size,components.size)"
node -e "
const {components}=require('./src/commands');
for(const [k,f] of components) if(!/staffLevel|isManagement|isBoss|permissions\.has/.test(f.toString())) console.log('ungated:',k);
" | sort

# settings crash probe
node -e "
process.env.DB_PATH=':memory:';require('./tests/sqlite-compat').install();
const {openMemoryDb,getDb}=require('./src/database');openMemoryDb();
getDb().prepare(\"INSERT INTO settings (key,value) VALUES ('activity.ticket','not-json')\").run();
require('./src/services/settings').channelId('staff-faq');
"
```

---

*Want me to implement Sprint 0 (items 1–6) as a reviewed commit on this branch? It's a small, self-contained patch set: centralized component authorization, safe settings parsing, graceful shutdown, dead-code cleanup, eslint + CI, README regeneration.*
