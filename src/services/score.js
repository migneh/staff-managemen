'use strict';
const { getDb } = require('../database');
const { rankInfo } = require('./permissions');
const settings = require('./settings');

/** يختار قيمة حسب سلم (thresholds تنازلي) */
function tier(value, ladder) {
  for (const [min, pts] of ladder) if (value >= min) return pts;
  return ladder[ladder.length - 1][1];
}

const CHAT_LADDER = [[200, 25], [150, 20], [100, 15], [50, 10], [0, 5]];
const PRESENCE_25 = [[26, 25], [21, 20], [16, 15], [11, 10], [0, 5]];
const PRESENCE_20 = [[26, 20], [21, 16], [16, 12], [11, 8], [0, 4]];
const TICKETS_LADDER = [[50, 30], [35, 25], [20, 20], [10, 15], [0, 5]];
const ACTIONS_LADDER = [[60, 30], [40, 25], [25, 20], [10, 15], [0, 5]];

function speedRatingPoints(avgMinutes, avgRating) {
  if (avgMinutes == null || avgRating == null) return 10;
  if (avgMinutes < 5 && avgRating >= 4.5) return 25;
  if (avgMinutes < 10 && avgRating >= 4.0) return 20;
  if (avgMinutes < 15 && avgRating >= 3.5) return 15;
  return 10;
}

/**
 * تقييم المشرف اليدوي: إما غير مُقيَّم إطلاقاً (يُستثنى من المقام بدل منح
 * نقاط مجانية بمجرد عدم التقييم)، أو محرّك صريح من 0 إلى max.
 * أي أن "لم يُقيَّم" لم تعد تساوي "جيد".
 */
function ratingFactor(value, max, label) {
  if (value == null) return { pts: 0, assessed: false, label: `${label}: لم يُقيَّم` };
  return { pts: Math.max(0, Math.min(max, Number(value) || 0)), assessed: true, label: `${label}: ${value}/${max}` };
}

function ratingDetail(value) {
  return value == null ? 'لم يُقيَّم بعد (يُستثنى من الحساب ولا يمنح نقاطاً)' : 'تقييم المشرف';
}

/**
 * أوزان القنوات: تُطبَّق فعلياً على احتساب الرسائل.
 * الوزن المعلن في /setup (تكتات 50% • إدارة 25% • إشراف 25% • عام 10%) لم يكن
 * يُقرأ أبداً في Score — الرسالة في أي قناة كانت تساوي 1. الآن صار للوزن أثر حقيقي.
 */
function weightedMessages(userId, since, until = null) {
  const end = until ? ' AND created_at < datetime(\'now\', ?)' : '';
  const params = until ? [userId, since, until] : [userId, since];
  return getDb().prepare(`SELECT COALESCE(SUM(weight), 0) w FROM activity_logs
    WHERE user_id = ? AND created_at >= datetime('now', ?)` + end).get(...params).w;
}

/** بيانات الشهر الخام لإداري */
function monthlyRaw(userId, days = 30, offsetDays = 0) {
  const db = getDb();
  const span = Math.max(1, Math.trunc(Number(days) || 30));
  const offset = Math.max(0, Math.trunc(Number(offsetDays) || 0));
  const since = `-${span + offset} days`;
  const until = offset ? `-${offset} days` : null;
  const timeRange = (column) => until
    ? ` AND ${column} < datetime('now', ?)`
    : '';
  const timeArgs = (extra = []) => until ? [...extra, until] : extra;
  const act = db.prepare(`SELECT COUNT(*) msgs, COUNT(DISTINCT day) days FROM activity_logs WHERE user_id = ? AND created_at >= datetime('now', ?)` + timeRange('created_at'))
    .get(...timeArgs([userId, since]));
  act.weighted = weightedMessages(userId, since, until);
  const t = db.prepare(`SELECT COUNT(*) c, AVG(rating) r, AVG(duration) d, SUM(reopened) reopened FROM ticket_metrics WHERE claimer = ? AND closed_at >= datetime('now', ?)` + timeRange('closed_at'))
    .get(...timeArgs([userId, since]));
  const m = db.prepare(`SELECT COUNT(*) c FROM mod_actions WHERE moderator_id = ? AND created_at >= datetime('now', ?)` + timeRange('created_at'))
    .get(...timeArgs([userId, since]));
  const w = db.prepare(`SELECT COUNT(*) c FROM warnings WHERE user_id = ? AND voided_at IS NULL AND created_at >= datetime('now', ?)` + timeRange('created_at'))
    .get(...timeArgs([userId, since]));
  const n = db.prepare(`SELECT SUM(note_type='positive') pos, SUM(note_type='negative') neg FROM staff_notes WHERE user_id = ? AND created_at >= datetime('now', ?)` + timeRange('created_at'))
    .get(...timeArgs([userId, since]));
  const lv = until
    ? db.prepare(`SELECT COALESCE(SUM(julianday(MIN(end_date, date('now', ?))) - julianday(MAX(start_date, date('now', ?))) + 1), 0) d
      FROM leave_requests WHERE user_id = ? AND status IN ('approved','ended') AND end_date >= date('now', ?) AND start_date < date('now', ?)`).get(until, since, userId, since, until)
    : db.prepare(`SELECT COALESCE(SUM(julianday(MIN(end_date, date('now'))) - julianday(MAX(start_date, date('now', ?))) + 1), 0) d
      FROM leave_requests WHERE user_id = ? AND status IN ('approved','ended') AND end_date >= date('now', ?)`).get(since, userId, since);
  return {
    messages: act.msgs, weightedMessages: Math.round((act.weighted || 0) * 100) / 100, activeDays: act.days,
    tickets: t.c, avgRating: t.r != null ? Math.round(t.r * 100) / 100 : null, avgDuration: t.d != null ? Math.round(t.d) : null, reopened: t.reopened || 0,
    actions: m.c, warnings: w.c, positiveNotes: n.pos || 0, negativeNotes: n.neg || 0,
    leaveDays: Math.max(0, Math.round(lv.d || 0)),
  };
}

/**
 * حساب الـ Score (0-100) مع تفصيل العوامل
 */
function compute(staff, raw) {
  // الإدارة العامة لا تدخل في Score أو شروط الترقيات؛ نعرض حالة محايدة بدلاً من احتساب تكتات/مخالفات.
  if (staff.team === 'general_management') {
    return { score: 100, factors: [{ name: 'نظام الإدارة العامة', pts: 100, max: 100, detail: 'خارج سلم Score والترقيات' }], raw: raw || monthlyRaw(staff.user_id) };
  }
  raw = raw || monthlyRaw(staff.user_id);
  // الرسائل تُحتسب بوزن قنواتها (تكتات 50% / إدارة 25% / إشراف 25% / عام 10%).
  // إن غاب الوزن (بيانات قديمة) نرجع لعدد الرسائل كما هو.
  const msgPoints = raw.weightedMessages != null ? raw.weightedMessages : raw.messages;
  const msgDetail = raw.weightedMessages != null
    ? `${raw.messages} رسالة • وزن ${Math.round(msgPoints)}`
    : `${raw.messages} رسالة`;

  const factors = [];
  const rank = staff.team === 'support' ? rankInfo('support', staff.rank) : null;
  const profile = staff.team === 'support' && rank?.handlesTickets ? 'support' : staff.team === 'moderation' ? 'moderation' : 'helper';
  const weights = settings.scoreWeights(profile);
  // العوامل المحسوبة مُقيَّمة دائماً؛ العوامل البشرية تمرّر حالتها. عند تغيير الوزن
  // نعيد تحجيم النقاط النسبية، ويبقى مجموع الأوزان 100 حتى يظل Score قابلاً للفهم.
  const push = (name, pts, max, detail, assessed = true, weightKey = null) => {
    const factorMax = weightKey ? weights[weightKey] : max;
    const factorPts = !assessed ? 0 : weightKey ? (pts / max) * factorMax : pts;
    factors.push({ name, pts: Math.round(factorPts * 100) / 100, max: factorMax, detail, assessed });
  };

  if (staff.team === 'support') {
    const info = rankInfo('support', staff.rank);
    if (info && !info.handlesTickets) {
      push('نشاط الشات', tier(msgPoints, CHAT_LADDER), 25, msgDetail, true, 'chat');
      push('التواجد', tier(raw.activeDays, PRESENCE_25), 25, `${raw.activeDays} يوم`, true, 'presence');
      const interaction = ratingFactor(staff.team_interaction, 25, 'تفاعل الفريق');
      push('التفاعل مع الفريق', interaction.pts, 25, ratingDetail(staff.team_interaction), interaction.assessed, 'teamInteraction');
      const supervisor = ratingFactor(staff.supervisor_rating, 25, 'تقييم المشرف');
      push('تقييم المشرف', supervisor.pts, 25, ratingDetail(staff.supervisor_rating), supervisor.assessed, 'supervisorRating');
    } else {
      push('التكتات المغلقة', tier(raw.tickets, TICKETS_LADDER), 30, `${raw.tickets} تكت`, true, 'tickets');
      push('سرعة الرد + التقييم', speedRatingPoints(raw.avgDuration, raw.avgRating), 25, `${raw.avgDuration ?? '—'} د / ${raw.avgRating ?? '—'} ⭐`, true, 'speed');
      push('نشاط الشات', tier(msgPoints, CHAT_LADDER), 25, msgDetail, true, 'chat');
      push('التواجد', tier(raw.activeDays, PRESENCE_20), 20, `${raw.activeDays} يوم`, true, 'presence');
    }
  } else {
    push('المخالفات المعالجة', tier(raw.actions, ACTIONS_LADDER), 30, `${raw.actions} إجراء`, true, 'actions');
    const speed = ratingFactor(staff.response_speed, 25, 'سرعة الاستجابة');
    push('سرعة الاستجابة', speed.pts, 25, ratingDetail(staff.response_speed), speed.assessed, 'speed');
    push('التواجد والنشاط', tier(msgPoints, CHAT_LADDER), 25, msgDetail, true, 'activity');
    push('الالتزام', tier(raw.activeDays, PRESENCE_20), 20, `${raw.activeDays} يوم`, true, 'commitment');
  }
  // عند غياب تقييم المشرف نُعيد توزيع وزنه بصدق بدل منح نقاط مجانية:
  // المقياس يُحسب على «المُقيَّم فعلاً» ثم يُوحَّد إلى 100.
  const assessedMax = factors.reduce((s, f) => s + (f.assessed ? f.max : 0), 0);
  const rawPoints = factors.reduce((s, f) => s + f.pts, 0);
  const score = factors.length && assessedMax === 0
    ? Math.round(Math.min(100, rawPoints))
    : Math.round(Math.min(100, (rawPoints / assessedMax) * 100));
  return { score, factors, raw, assessedMax };
}

function grade(score) {
  if (score >= 85) return 'ممتاز';
  if (score >= 70) return 'جيد';
  if (score >= 50) return 'يحتاج تحسين';
  return 'ضعيف';
}

module.exports = { compute, monthlyRaw, grade, tier };
