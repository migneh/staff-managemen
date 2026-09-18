# 🗺️ ROADMAP — from "works well" to "indispensable"

Companion to [`CODE-REVIEW.md`](./CODE-REVIEW.md). The review lists *findings*; this is the *plan*: what to change, in what order, and how you'll know it worked.

> ## ✅ ما أُنجز (2026-09-18)
>
> **المرحلة 0 (الثقة)** و**المرحلة 1 (سهولة التطوير)** و**المرحلة 2 (بيانات تدوم)** مكتملتان في الإصدار 1.1.0:
> الصلاحيات مفروضة مركزياً، التواريخ موحّدة، الإيقاف له نهاية، البوت لا يسقط بصمت،
> ومعه ESLint وCI (`.github/workflows/ci.yml`) وبوابة سجل الأوامر وتوليد جدول README.
> المرحلة 2 أضافت `staff_rank_history`، وعصور النقاط (`rank_epoch`)، وصيانة البيانات
> الدورية، وفحص سلامة النسخ الاحتياطية مع دليل استرجاع ([`docs/RESTORE.md`](./docs/RESTORE.md)).
> التفاصيل في [`CHANGELOG.md`](./CHANGELOG.md). ما تبقى هنا (المرحلة 3) صار أسهل تنفيذاً
> لأن الأساس صار مختبراً.

---

## ملخص تنفيذي (للإدارة)

البوت اليوم يغطي كل ما يحتاجه الفريق فعلياً: إجازات، استقالات، تكتات، ملاحظات وإنذارات، ترقيات، وتقارير. لذلك الخطوة التالية **ليست إضافة أنظمة جديدة**، بل ترتيب الأولويات على أربع مراحل:

| المرحلة | المدة | الفائدة التي ستلاحظها |
|---|---|---|
| **0 — الثقة** | ٢–٣ أيام | لا صلاحيات خاطئة، لا تأخير يوم كامل في تفعيل الإجازات، إمكانية إلغاء الإيقاف، والبوت لا يتوقف بصمت. لا يرى الفريق فرقاً ظاهراً — لكنه يمنع أخطاء حقيقية. |
| **1 — سهولة التطوير** | أسبوع | اختبارات تلقائية وCI وفحص أنواع: أي تعديل لاحق يصبح أسرع وأقل خطراً. |
| **2 — بيانات تبقى** | أسبوع | تاريخ موثّق للرتب والنقاط (من رقّى مَن ومتى)، قاعدة بيانات لا تتضخم، ونسخ احتياطية مُجرَّبة فعلاً. |
| **3 — ما يشعر به الفريق** | ٢–٣ أسابيع (حسب الأولوية) | شفافية النقاط، شاشة `/me` توضح «ما الذي ينقصني للترقية»، متابعة زمن الاستجابة وتوزيع الحمل، تقويم إجازات وتغطية، ترحيب وخروج منظّم، واستئناف الإنذارات. |

**المبادئ الثلاثة بالترتيب: الثقة ← سهولة التطوير ← الفائدة اليومية.**

**ما لن نفعله:** لوحة تحكم ويب قبل إصلاح الصلاحيات، ترقيات تلقائية بدون قرار بشري، إعادة كتابة كاملة للنظام، أو تخزين محتوى الرسائل دون حاجة.

**ما نحتاجه من الإدارة:** سبعة قرارات صغيرة في [نهاية الملف](#appendix--decisions-needed-from-the-team) — بدونها ستبقى بعض ميزات المرحلة 3 بلا اتجاه.

**Guiding idea:** a staff bot earns its place in three layers, in this order:

| Layer | Meaning | If you skip it… |
|---|---|---|
| 🛡️ **Trust** | It never loses data, never acts on the wrong day, never lets the wrong person do the wrong thing | Staff stop believing the numbers and go back to spreadsheets |
| 🔧 **Leverage** | You can change it in an afternoon without breaking something else | Every new feature costs a week and introduces two regressions |
| ❤️ **Love** | It saves staff time and makes them feel seen | It's "that bot admins force you to use" |

Most bots fail at layer 1 and then pile on layer-3 features. You're in good shape: the product surface is already strong, so the plan front-loads trust and leverage, then makes the loved features cheap.

**Effort legend:** S = a few hours · M = 1–2 days · L = a week-ish.

---

## Phase 0 — Trust (do this before anything else) · ~2–3 days

> في هذه المرحلة: البوت يصبح جديرًا بالثقة — لا صلاحيات خاطئة، لا تواريخ خاطئة، لا فقدان بيانات.

### 0.1 Declarative component authorization · **S–M** · `src/index.js`, `src/commands/index.js`

Today, `/` commands declare `level`, `team`, `serverManagerOnly` — components don't declare anything, so each handler has to remember to check. Three of them forgot (see review §1.1).

**Change:** make a component's permissions part of its registration, enforce centrally, default-deny.

```js
// src/commands/index.js
const DEFAULTS = { level: LEVELS.STAFF, team: null, scope: 'staff' }; // scope: staff | self | admin

for (const m of modules) {
  for (const [id, def] of Object.entries(m.components || {})) {
    if (components.has(id)) throw new Error(`duplicate component id: ${id}`);
    const entry = typeof def === 'function'
      ? { ...DEFAULTS, handle: def }                  // legacy: staff-level
      : { ...DEFAULTS, ...def };                      // explicit metadata wins
    components.set(id, entry);
  }
}
```

```js
// src/index.js — one gate for every component
const r = resolveComponent(i.customId);
if (!r) return;
const lvl = i.staffLevel || (serverManager ? LEVELS.GENERAL_MANAGER : 0);
if (lvl < r.entry.level) return replyEphemeral(i, '❌ لا تملك هذه الصلاحية.', COLORS.danger);
if (r.entry.team && i.staffInfo?.team !== r.entry.team && !serverManager)
  return replyEphemeral(i, '❌ هذا الإجراء يخص فريقاً آخر.', COLORS.danger);
if (r.entry.scope === 'self' && r.entry.ownerOf && !entry.ownerOf(i, r.args))
  return replyEphemeral(i, '❌ هذا الزر ليس لك.', COLORS.danger);
return r.entry.handle(i, r.args);
```

**Done when:** `promo:reject`, `faq:hist`, `leave:details`, `modaction:log`, `ticket:log` carry explicit levels; a test iterates every registered component and fails if any lacks a level.

### 0.2 One clock, one timezone · **M** · new `src/clock.js`

Every date decision (`today()`, `nowIso()`, "starts tomorrow") must agree with the cron timezone, or the nightly jobs act on yesterday (review §2.1).

```js
// src/clock.js
const TZ = process.env.TZ || 'Asia/Riyadh';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const tsFmt  = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, dateStyle: 'short', timeStyle: 'medium' });

const today = () => dayFmt.format(new Date());          // YYYY-MM-DD in server-local time
const now   = () => tsFmt.format(new Date());           // YYYY-MM-DD HH:MM:SS in server-local time
const addDays = (d, n) => /* pure, string in → string out */;
const daysBetween = (a, b) => /* pure */;
module.exports = { TZ, today, now, addDays, daysBetween, isValidDate, hoursSince, monthsSince };
```

Then: `grep -rn "toISOString().slice(0, ?10)" src/` → replace all with `clock.today()`. Freeze the clock in tests (`node:test` `mock.timers`) and assert "a leave starting today is activated by the 00:05 run".

**Done when:** zero `toISOString()` calls outside `clock.js`; a test proves the 00:05 Riyadh run sees *today*, not yesterday.

### 0.3 Suspension must end · **S** · `src/commands/records.js`, `src/index.js`

Add `suspended_until` + `/unsuspend` (Boss+), and auto-lift when it passes. Keep the 60-day promotion cooldown separate — "punished until date X" ≠ "excluded from promotion for 60 days".

**Done when:** a final warning suspends with an explicit end date, the member is told it, and the bot re-enables them automatically (or a Boss can with one command, audited).

### 0.4 Survive the environment · **S** · `src/index.js`

- `client.login(token).catch(e => { log.error('login failed', e); process.exit(1); })`
- `SIGINT`/`SIGTERM` → stop cron, `client.destroy()`, flush pending writes, `db.close()`
- `client.on('error'|'warn')`, `process.on('uncaughtException')`
- per-job overlap guard + a `job_runs` table (`job, started_at, finished_at, ok, note`) so `/status` can show "last run".

**Done when:** `kill -TERM` exits cleanly in < 2 s; a job that overruns doesn't start twice; `/status` shows the last run of every job.

### 0.5 Data you can't corrupt · **S** · `src/services/settings.js`, `src/database.js`, `src/config.js`

- Safe `JSON.parse` per settings row (drop + log the bad key instead of crashing everything).
- `PRAGMA user_version` migration runner (replace the ad-hoc `table_info` dance, keep the existing steps).
- Fail fast on a broken `config.json`; never silently load `config.example.json` in production.

**Done when:** a corrupted settings row degrades one feature, not the whole bot; `PRAGMA user_version` is authoritative.

---

## Phase 1 — Leverage (make change cheap) · ~1 week

> في هذه المرحلة: أي تعديل مستقبلي يصبح أسرع وأأمن — مع اختبارات وCI.

### 1.1 Type checking without a rewrite · **M**

Add `jsconfig.json` + `"checkJs": true` and `// @ts-check` at the top of `src/services/*.js`, then `npx tsc --noEmit` in CI. You get 80 % of TypeScript's bug-catching (typos on row fields, wrong argument order, `null` handling) for ~0 rewrites.

Start with `services/` (pure logic, easiest), then `commands/`.

### 1.2 A test suite that guards the rules · **M–L**

Add, in this order:
1. **Permission matrix** — table of `{ command|component → required level/team }`, asserted against the registry. This is the test that prevents a repeat of §1.1.
2. **Clock/scheduler** — fake timers, assert leave activation, reminders, expiry, resignation escalation.
3. **Services** — `leaves.validate` edge cases (gap, overlap, rolling cap, 90-day), `points`/`score` invariants, `ticketLogs` parsing with real-world Arabic variants.
4. **Golden embeds** — snapshot a few key payloads (leave card, promotion card, FAQ panel) so UI refactors don't silently break wording.
5. **Boot smoke test** — load every module, assert `data.name === key`, unique ids, registered level, no prefix collisions.

Target: ≥ 60 % on `services/`, 100 % of components declaring a level. Wire `node --test --experimental-test-coverage` into CI with a threshold.

### 1.3 CI that blocks regressions · **S**

`.github/workflows/ci.yml`: `npm ci --ignore-scripts` → `npm run lint` → `npx tsc --noEmit` → `npm test`. Add eslint (`no-unused-vars` alone would have caught 9 dead imports) + prettier, and a `CHANGELOG.md` with conventional commits.

### 1.4 See failures without SSH · **S** · new `src/logger.js`

Levels (`debug/info/warn/error`), a scope per module, and — the important part — `error` entries mirrored to `#staff-logs` (rate-limited, with a 1-line stack). Right now the only witness to a failure is whoever is watching the terminal.

### 1.5 A preflight, not a surprise · **S** · `src/index.js`

On boot, check and print a ✅/❌ checklist: intents present, bot's highest role above every configured staff role, `Manage Roles`/`Manage Channels` perms, every configured channel still exists, `in vacation` role resolvable, backup dir writable. Non-fatal issues go to `#staff-alerts`.

---

## Phase 2 — Data that lasts · ~1 week

> في هذه المرحلة: سجل تاريخي موثوق + قاعدة بيانات لا تتضخم.

| # | Item | Why it matters | Effort |
|---|---|---|---|
| 2.1 | `staff_rank_history` (promotions/demotions/removals with actor + reason) | Today rank changes are overwritten; you can't answer "how long was X an Admin?" or "who promoted whom" from data | S |
| 2.2 | Append-only points ledger with **rank epochs** (replace the synthetic `rank_reset` negative row) | Makes "points earned in this rank" derivable and auditable instead of a hack that pollutes history | S |
| 2.3 | Retention: `activity_logs` → monthly rollup table, prune raw rows > 12 months; audit prune policy; `VACUUM` | One row **per message** with no pruning is a time bomb | M |
| 2.4 | Backups you've actually restored: verify (`PRAGMA integrity_check`), offsite copy (rclone/S3), and a documented **restore drill** | An untested backup is a rumour, not a backup | S |
| 2.5 | `stats`/`/status` surface: DB size, rows per table, last backup age, last job runs | Turns silent decay into something you can see | S |

**Done when:** you can answer "who promoted this person and when", the DB size is stable month over month, and a restore drill succeeds in under 15 minutes.

---

## Phase 3 — The features that make staff *want* to use it · 2–3 weeks, pick by value

Each of these is cheap **after** Phase 0–2, and each maps to a real staff pain point. Order = my recommendation for a support/moderation community.

### 3.1 Transparency: points you can defend · **M**
`/points-history` (already half-built in `promotion-status`) → full ledger + **CSV export** + "contest this point" button that files a task for management. Half of all staff drama is "why did I lose points?" — answering it in-app removes the drama.

### 3.2 `/me` 2.0 — the "what do I do next" screen · **S–M**
Progress toward the next rank as a single %, the **one** blocking condition highlighted, streak, this week vs last week delta, and one-tap actions (request leave, confirm FAQ reads, open my tasks). Everything needed is already computed in `promotions.evaluate` + `reports.individual`.

### 3.3 Onboarding 2.0 · **M**
Welcome DM + assigned **buddy/mentor** + the 3 onboarding tasks with due dates, reminders at 48 h, and a manager sign-off step. You have the task skeleton (`services/tasks.js`); it needs dates, reminders, and a human checkpoint before switching `probation → active`.

### 3.4 Offboarding 2.0 · **M**
Turn the resignation flow into a checklist board: handover items per ticket, knowledge doc (FAQ draft from their answers), exit interview scheduled as a DM form, auto role removal at the agreed date (already deferred-capable), and an anonymised reasons dashboard (already exists — make it trend-aware).

### 3.5 SLA & load balance · **M**
Tickets already carry `duration`, `rating`, `claimer`, `closed_at`:
- alert when a ticket has no claim for > X hours (`#staff-alerts`),
- per-person **load** view (open / claimed / avg close time this week),
- weekly fairness check: who's carrying the team, who's idle.

This is the single most "manager-loved" feature and it's 100 % derivable from data you already collect.

### 3.6 Leave & coverage calendar · **M**
A 14-day grid embed (per-day coverage bar, who's out, class of leave), **coverage forecast** before approving, blackout periods (e.g. launch week → `policy` key + validation rule), and leave **swap requests** between two members.

### 3.7 Recognition that isn't just points · **S**
`/shoutout @member reason` (peers, feeds points + a #staff-wins channel), streak tracking (consecutive active weeks), monthly awards with a badge role, and a "best of month" announcement that includes the *why* (top factor from their Score).

### 3.8 Appeals & two-way discipline · **M**
Any warning/note gets an "استئناف" button for the member → creates a management task with SLA → decision logged in audit. Discipline that feels fair survives contact with a real team.

### 3.9 Reporting people actually read · **S–M**
Weekly DM digest (opt-in/out), trend arrows vs last period, one embed per person with the 2 numbers that matter for **their** rank, and a monthly HTML/CSV export the server owner can keep.

---

## Phase 4 — Ops & scale (only when you need it)

| # | Item | Trigger to do it | Effort |
|---|---|---|---|
| 4.1 | **Health endpoint** (`/healthz`: uptime, last job run, DB size, backup age; bind `127.0.0.1` + token, or behind a reverse proxy) + `/metrics` for Uptime Kuma/Prometheus | You want an alert *before* staff notice the bot is down | S |
| 4.2 | Docker/compose or a systemd unit + auto-deploy workflow on green CI | Manual deploys start causing downtime | S |
| 4.3 | Score weights configurable from `/setup` + a "why is my score 62?" explainer | Management asks "can we weight tickets more?" | M |
| 4.4 | Migrate `better-sqlite3` → `node:sqlite` | You want zero native-build pain (drop Node < 22) | M |
| 4.5 | Per-guild settings scoping (multi-server) | You're asked to run it for a second community | L |
| 4.6 | PostgreSQL | > ~50k messages/day, or multi-guild + concurrency | L |

---

## Anti-goals — what *not* to do

- 🚫 **Don't build a web dashboard before Phase 0–1.** You'd be exposing the same unauthorised actions through a nicer UI.
- 🚫 **Don't automate promotions.** The system's best design choice is that a human approves; keep it that way, and make the *evidence* better instead.
- 🚫 **Don't store what you don't need.** You wisely avoid logging message text — keep it that way; state a retention window publicly.
- 🚫 **Don't rewrite in TypeScript wholesale.** `@ts-check` + JSDoc gets you the safety without freezing feature work for a month.
- 🚫 **Don't add a second source of truth.** Settings already live in the DB *and* `config.json`; pick the DB, keep the file only for bootstrap secrets.

---

## How you'll know it got better (measurable)

| Metric | Today | Target |
|---|---|---|
| Permission incidents (wrong person acts) | possible via 3+ handlers | **0** |
| Leave/vacation transitions later than 1 h after local midnight | ~24 h late | **0** |
| Components without a declared level | 72 undeclared | **0** |
| Test coverage on `services/` | not measured | **> 60 %**, permission matrix 100 % |
| p95 latency on the `MessageCreate` path | ~5 sync queries/message | **≤ 2**, with batched writes |
| DB growth (activity_logs) | unbounded | **flat** after rollup |
| Backup age / verified restores | unknown | **< 26 h**, drill done quarterly |
| "How do I check X?" questions in `#staff-help` | — | **down** (because `/me` answers them) |

---

## If you only have one weekend

1. **0.1** component authorization + the matrix test (half a day, removes the real security hole).
2. **0.2** the clock module (half a day, fixes every date-based complaint at once).
3. **1.3** CI with lint + test (two hours, stops the bleeding permanently).
4. **3.2** `/me` 2.0 (the rest of the day — the feature your staff will feel immediately).

That order is deliberate: two of those four are invisible to your staff, and they're the two that keep the other two honest.

---

## Appendix — decisions needed from the team

These are product calls, not technical ones. They gate parts of Phase 3, so decide them before the work starts (each has a default I'd recommend):

| # | Question | Recommended default |
|---|---|---|
| 1 | **`/log-ticket`** — who may log a ticket for someone else? | Self only for Helper+; Supervisor+ may log for others, every override in the audit log + a daily cap |
| 2 | **Suspension** — automatic expiry or a Boss decision? | An explicit end date at issue time + `/unsuspend` for early release; both audited |
| 3 | **Manual points** (`source = manual`) — full weight, reduced, or pending confirmation? | Reduced weight (or quarantined until a Supervisor confirms) so the ledger can't be inflated |
| 4 | **Data retention** — how long do we keep activity and audit logs? | 12 months raw activity → monthly rollups; audit 24 months. Publish the rule to staff |
| 5 | **Manual promotion override** (`/promote`) — do we need one? | Yes, for Boss only, with a mandatory reason and an audit entry |
| 6 | **Appeals** — add a formal appeals flow for warnings? | Yes — it's the cheapest trust win, and it converts conflict into a tracked task |
| 7 | **Peer recognition** — can staff give points to each other (`/shoutout`)? | Caps + Supervisor visibility: peers can *nominate*, management confirms |

Once these are answered, Phase 3 items become ordinary tickets instead of open discussions.
