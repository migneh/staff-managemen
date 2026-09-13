'use strict';
const { getDb } = require('../database');
const { rankInfo } = require('./permissions');

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

/** بيانات الشهر الخام لإداري */
function monthlyRaw(userId, days = 30) {
  const db = getDb();
  const since = `-${days} days`;
  const act = db.prepare(`SELECT COUNT(*) msgs, COUNT(DISTINCT day) days FROM activity_logs WHERE user_id = ? AND created_at >= datetime('now', ?)`).get(userId, since);
  const t = db.prepare(`SELECT COUNT(*) c, AVG(rating) r, AVG(duration) d, SUM(reopened) reopened FROM ticket_metrics WHERE claimer = ? AND closed_at >= datetime('now', ?)`).get(userId, since);
  const m = db.prepare(`SELECT COUNT(*) c FROM mod_actions WHERE moderator_id = ? AND created_at >= datetime('now', ?)`).get(userId, since);
  const w = db.prepare(`SELECT COUNT(*) c FROM warnings WHERE user_id = ? AND created_at >= datetime('now', ?)`).get(userId, since);
  const n = db.prepare(`SELECT SUM(note_type='positive') pos, SUM(note_type='negative') neg FROM staff_notes WHERE user_id = ? AND created_at >= datetime('now', ?)`).get(userId, since);
  const lv = db.prepare(`SELECT COALESCE(SUM(julianday(MIN(end_date, date('now'))) - julianday(MAX(start_date, date('now', ?))) + 1), 0) d
    FROM leave_requests WHERE user_id = ? AND status IN ('approved','ended') AND end_date >= date('now', ?)`).get(since, userId, since);
  return {
    messages: act.msgs, activeDays: act.days,
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
  const factors = [];
  const push = (name, pts, max, detail) => factors.push({ name, pts, max, detail });

  if (staff.team === 'support') {
    const info = rankInfo('support', staff.rank);
    if (info && !info.handlesTickets) {
      push('نشاط الشات', tier(raw.messages, CHAT_LADDER), 25, `${raw.messages} رسالة`);
      push('التواجد', tier(raw.activeDays, PRESENCE_25), 25, `${raw.activeDays} يوم`);
      push('التفاعل مع الفريق', staff.team_interaction ?? 10, 25, staff.team_interaction != null ? 'تقييم المشرف' : 'لم يُقيَّم بعد (افتراضي)');
      push('تقييم المشرف', staff.supervisor_rating ?? 10, 25, staff.supervisor_rating != null ? 'تقييم المشرف' : 'لم يُقيَّم بعد (افتراضي)');
    } else {
      push('التكتات المغلقة', tier(raw.tickets, TICKETS_LADDER), 30, `${raw.tickets} تكت`);
      push('سرعة الرد + التقييم', speedRatingPoints(raw.avgDuration, raw.avgRating), 25, `${raw.avgDuration ?? '—'} د / ${raw.avgRating ?? '—'} ⭐`);
      push('نشاط الشات', tier(raw.messages, CHAT_LADDER), 25, `${raw.messages} رسالة`);
      push('التواجد', tier(raw.activeDays, PRESENCE_20), 20, `${raw.activeDays} يوم`);
    }
  } else {
    push('المخالفات المعالجة', tier(raw.actions, ACTIONS_LADDER), 30, `${raw.actions} إجراء`);
    push('سرعة الاستجابة', staff.response_speed ?? 10, 25, staff.response_speed != null ? 'تقييم المشرف' : 'لم يُقيَّم بعد (افتراضي)');
    push('التواجد والنشاط', tier(raw.messages, CHAT_LADDER), 25, `${raw.messages} رسالة`);
    push('الالتزام', tier(raw.activeDays, PRESENCE_20), 20, `${raw.activeDays} يوم`);
  }
  const score = Math.min(100, factors.reduce((s, f) => s + f.pts, 0));
  return { score, factors, raw };
}

function grade(score) {
  if (score >= 85) return 'ممتاز';
  if (score >= 70) return 'جيد';
  if (score >= 50) return 'يحتاج تحسين';
  return 'ضعيف';
}

module.exports = { compute, monthlyRaw, grade, tier };
