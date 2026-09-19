'use strict';
const { getDb } = require('../database');
const { SUPPORT_PROMOTIONS, MOD_PROMOTIONS, PROBATION } = require('../constants');
const points = require('./points');
const score = require('./score');
const clock = require('../clock');

/** الحد الأدنى لنسبة التكتات المُقيَّمة قبل الاعتماد على المتوسط */
const MIN_RATED_SHARE = PROBATION.minRatedShare;
/**
 * التقييم البشري (تقييم المشرف/التفاعل/سرعة الاستجابة) صالح لهذه المدة فقط.
 * تقييم عمره سنة يقول شيئاً عن الماضي لا عن أهلية الترقية اليوم.
 */
const RATING_VALID_DAYS = 90;

function nextPromotion(staff) {
  const list = staff.team === 'support' ? SUPPORT_PROMOTIONS : MOD_PROMOTIONS;
  return list.find(p => p.from === staff.rank) || null;
}

/**
 * «أداء مستقر» = تقارير شهرية محفوظة (saved_reports) بها Score ≥ الحد، بعدد
 * الأشهر المطلوب. التقارير تُحفظ تلقائياً كل شهر فلا حاجة لأي إدخال يدوي.
 */
function stability(userId, months, minScore) {
  if (!months) return null;
  const rows = getDb().prepare(`SELECT period, data FROM saved_reports WHERE report_type = 'monthly' ORDER BY period DESC`).all();
  const byPeriod = new Map();
  for (const r of rows) {
    const period = String(r.period).split(':')[0];
    if (byPeriod.has(period)) continue;
    let data = null;
    try { data = JSON.parse(r.data); } catch { data = null; }
    const member = data?.members?.find(m => m.user === userId);
    if (member) byPeriod.set(period, member.score);
  }
  const periods = [...byPeriod.keys()].sort().reverse().slice(0, months);
  const values = periods.map(p => byPeriod.get(p));
  const passed = periods.length >= months && values.every(v => v >= minScore);
  return { periods, values, passed, months, minScore };
}

function windowLabel(days) {
  return days >= 90 ? `${Math.round(days / 30)} شهور` : `${days} يوم`;
}

/**
 * يفحص كل شروط الترقية التالية ويعيد تقريراً مفصلاً.
 * النوافذ الزمنية موحّدة: التكتات/المخالفات/التقييم/التواجد على windowDays،
 * والإنذارات على warnWindowDays — بدل «منذ بداية الرتبة» بلا سقف الذي كان
 * يجعل الشرط الفعلي أضعف من المعلن للفريق.
 */
function evaluate(staff) {
  const rule = nextPromotion(staff);
  if (!rule) return { rule: null, eligible: false, checks: [], reason: 'لا توجد ترقية تلقائية لهذه الرتبة (يدوية بقرار Boss)' };

  const db = getDb();
  const today = clock.today();
  const windowDays = rule.windowDays || 90;
  const warnWindowDays = rule.warnWindowDays || windowDays;
  const since = clock.addDays(today, -windowDays);
  const warnSince = clock.addDays(today, -warnWindowDays);

  const sc = score.compute(staff);
  const pts = points.total(staff.user_id);
  const months = clock.monthsSince(staff.rank_since);
  const cd = points.activeCooldown(staff.user_id);

  const warnCount = db.prepare(`SELECT COUNT(*) c FROM warnings WHERE user_id = ? AND voided_at IS NULL AND date(created_at) >= ? AND warning_type != 'verbal'`).get(staff.user_id, warnSince).c;
  const wrongDecisions = db.prepare(`SELECT COUNT(*) c FROM promotion_points WHERE user_id = ? AND reason_key = 'wrong_decision' AND date(created_at) >= ?`).get(staff.user_id, since).c;
  const helpedNewbie = db.prepare(`SELECT COUNT(*) c FROM promotion_points WHERE user_id = ? AND reason_key = 'helped_newbie' AND date(created_at) >= ?`).get(staff.user_id, since).c;

  const checks = [];
  const ok = (label, pass, actual, required) => checks.push({ label, pass, actual, required });

  ok('مدة الخدمة بالرتبة', months >= rule.months, `${months.toFixed(1)} شهر`, `${rule.months} شهر`);
  ok('الـ Score', sc.score >= rule.score, `${sc.score}`, `${rule.score}+`);
  ok('نقاط الترقية', pts >= rule.points, `${pts}`, `${rule.points}`);

  if (staff.team === 'support') {
    const t = db.prepare(`SELECT COUNT(*) c, AVG(rating) r, SUM(rating IS NOT NULL) rated FROM ticket_metrics
      WHERE claimer = ? AND date(closed_at) >= ?`).get(staff.user_id, since);
    if (rule.tickets > 0) ok(`التكتات المغلقة (${windowLabel(windowDays)})`, t.c >= rule.tickets, `${t.c}`, `${rule.tickets}+`);
    if (rule.rating) {
      const ratedShare = t.c ? Math.round((t.rated / t.c) * 100) : 0;
      const insufficient = t.c >= PROBATION.minTicketsForRating && ratedShare < MIN_RATED_SHARE;
      const rating = t.r != null ? Math.round(t.r * 100) / 100 : null;
      const pass = !insufficient && rating != null && rating >= rule.rating;
      ok(`متوسط التقييم (${windowLabel(windowDays)})`, pass,
        insufficient ? `${rating ?? '—'} على ${ratedShare}% من التكتات` : `${rating ?? '—'} (${ratedShare}% مُقيَّمة)`,
        insufficient ? `يحتاج ${MIN_RATED_SHARE}% تقييمات على الأقل` : `${rule.rating}+`);
    }
    if (rule.minMessages) {
      const msgs = db.prepare(`SELECT COUNT(*) c FROM activity_logs WHERE user_id = ? AND date(created_at) >= ?`).get(staff.user_id, since).c;
      ok(`نشاط الشات (${windowLabel(windowDays)})`, msgs >= rule.minMessages, `${msgs}`, `${rule.minMessages}+`);
    }
    if (rule.requiresSupervisorRating) {
      const age = staff.human_ratings_at ? Math.abs(clock.daysBetween(staff.human_ratings_at.slice(0, 10), today)) : null;
      const stale = age != null && age > RATING_VALID_DAYS;
      const rated = staff.supervisor_rating != null && !stale;
      const actual = staff.supervisor_rating == null ? 'لم يُقيَّم بعد'
        : stale ? `${staff.supervisor_rating}/25 — تقييم قديم (${age} يوم)`
          : `${staff.supervisor_rating}/25${age != null ? ` (قبل ${age} يوم)` : ''}`;
      ok('تقييم المشرف', rated, actual, `تقييم خلال ${RATING_VALID_DAYS} يوماً`);
    }
    if (rule.requiresHelpedNewbie) ok('مساعدة الأعضاء الجدد', helpedNewbie > 0, `${helpedNewbie} مرة`, 'مرة واحدة على الأقل');
  } else {
    const a = db.prepare(`SELECT COUNT(*) c FROM mod_actions WHERE moderator_id = ? AND date(created_at) >= ?`).get(staff.user_id, since).c;
    ok(`المخالفات المعالجة (${windowLabel(windowDays)})`, a >= rule.actions, `${a}`, `${rule.actions}+`);
    if (rule.maxWrongDecisions != null) {
      ok('القرارات الخاطئة', wrongDecisions <= rule.maxWrongDecisions, `${wrongDecisions}`, `أقصى ${rule.maxWrongDecisions}`);
    }
    if (rule.requireConflictResolution) ok('حل النزاعات', sc.raw?.actions >= 5, `${sc.raw?.actions ?? 0} إجراء`, 'سجل إجراءات كافٍ');
  }

  if (rule.minActiveDays) {
    ok(`التواجد (${windowLabel(windowDays)})`, sc.raw.activeDays >= rule.minActiveDays, `${sc.raw.activeDays} يوم`, `${rule.minActiveDays}+`);
  }

  ok(`الإنذارات الرسمية (${windowLabel(warnWindowDays)})`, warnCount <= rule.maxWarnings, `${warnCount}`, `أقصى ${rule.maxWarnings}`);

  if (rule.stableMonths) {
    const st = stability(staff.user_id, rule.stableMonths, rule.stableMinScore);
    ok('أداء مستقر', !!st?.passed, st?.periods.length ? `${st.values.join(' • ')} (${st.periods.length} تقارير)` : 'لا توجد تقارير شهرية كافية',
      `${rule.stableMonths} تقارير متصلة ≥ ${rule.stableMinScore}`);
  }

  ok('فترة التبريد', !cd, cd ? `حتى ${cd.until}` : 'لا يوجد', 'لا يوجد');
  ok('الحالة', staff.status === 'active' || staff.status === 'probation', staff.status, 'active');

  return { rule, eligible: checks.every(c => c.pass), checks, score: sc.score, points: pts, months, windowDays, warnWindowDays };
}

function pendingRequest(userId) {
  return getDb().prepare(`SELECT * FROM promotion_requests WHERE user_id = ? AND status = 'pending'`).get(userId) || null;
}

function createRequest(staff, evaluation, note) {
  const res = getDb().prepare(`INSERT INTO promotion_requests (user_id, from_rank, to_rank, note, snapshot) VALUES (?, ?, ?, ?, ?)`)
    .run(staff.user_id, evaluation.rule.from, evaluation.rule.to, note || null, JSON.stringify(evaluation.checks));
  return res.lastInsertRowid;
}

function listPending() {
  return getDb().prepare(`SELECT * FROM promotion_requests WHERE status = 'pending' ORDER BY created_at`).all();
}

function getRequest(id) {
  return getDb().prepare('SELECT * FROM promotion_requests WHERE id = ?').get(id) || null;
}

function review(id, status, reviewerId, reason) {
  getDb().prepare(`UPDATE promotion_requests SET status = ?, reviewed_by = ?, review_reason = ?, reviewed_at = datetime('now') WHERE id = ?`)
    .run(status, reviewerId, reason || null, id);
}

// ===== نصاب الموافقات =====
/** يسجّل موافقة واحدة على الطلب (المفتاح الأساسي يمنع تصويت نفس الشخص مرتين) */
function recordApproval(requestId, userId) {
  const db = getDb();
  try {
    db.prepare('INSERT INTO promotion_approvals (request_id, user_id) VALUES (?, ?)').run(Number(requestId), userId);
  } catch (e) {
    if (!String(e.message).includes('UNIQUE')) throw e;
    return { recorded: false, count: approvalsCount(requestId) };
  }
  return { recorded: true, count: approvalsCount(requestId) };
}

function approvalsCount(requestId) {
  return getDb().prepare('SELECT COUNT(*) c FROM promotion_approvals WHERE request_id = ?').get(Number(requestId)).c;
}

function approvalsList(requestId) {
  return getDb().prepare('SELECT user_id, approved_at FROM promotion_approvals WHERE request_id = ? ORDER BY approved_at').all(Number(requestId));
}

module.exports = {
  nextPromotion, evaluate, stability, pendingRequest, createRequest, listPending, getRequest, review,
  recordApproval, approvalsCount, approvalsList, windowLabel, RATING_VALID_DAYS,
};
