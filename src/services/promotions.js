'use strict';
const { getDb } = require('../database');
const { SUPPORT_PROMOTIONS, MOD_PROMOTIONS } = require('../constants');
const points = require('./points');
const score = require('./score');
const { monthsSince } = require('../utils');

function nextPromotion(staff) {
  const list = staff.team === 'support' ? SUPPORT_PROMOTIONS : MOD_PROMOTIONS;
  return list.find(p => p.from === staff.rank) || null;
}

/**
 * يفحص كل شروط الترقية التالية ويعيد تقريراً مفصلاً.
 */
function evaluate(staff) {
  const rule = nextPromotion(staff);
  if (!rule) return { rule: null, eligible: false, checks: [], reason: 'لا توجد ترقية تلقائية لهذه الرتبة (يدوية بقرار Boss)' };

  const db = getDb();
  const sc = score.compute(staff);
  const pts = points.total(staff.user_id);
  const months = monthsSince(staff.rank_since);
  const cd = points.activeCooldown(staff.user_id);
  const warnCount = db.prepare(`SELECT COUNT(*) c FROM warnings WHERE user_id = ? AND created_at >= ? AND warning_type != 'verbal'`).get(staff.user_id, staff.rank_since).c;

  const checks = [];
  const ok = (label, pass, actual, required) => checks.push({ label, pass, actual, required });

  ok('مدة الخدمة بالرتبة', months >= rule.months, `${months.toFixed(1)} شهر`, `${rule.months} شهر`);
  ok('الـ Score', sc.score >= rule.score, `${sc.score}`, `${rule.score}+`);
  ok('نقاط الترقية', pts >= rule.points, `${pts}`, `${rule.points}`);
  if (staff.team === 'support') {
    const t = db.prepare('SELECT COUNT(*) c, AVG(rating) r FROM ticket_metrics WHERE claimer = ? AND closed_at >= ?').get(staff.user_id, staff.rank_since);
    if (rule.tickets > 0) ok('التكتات المغلقة', t.c >= rule.tickets, `${t.c}`, `${rule.tickets}+`);
    const rating = t.r != null ? Math.round(t.r * 100) / 100 : null;
    if (rule.tickets > 0 || rating != null) ok('متوسط التقييم', rating != null ? rating >= rule.rating : rule.tickets === 0, `${rating ?? '—'}`, `${rule.rating}+`);
  } else {
    const a = db.prepare('SELECT COUNT(*) c FROM mod_actions WHERE moderator_id = ? AND created_at >= ?').get(staff.user_id, staff.rank_since);
    ok('المخالفات المعالجة', a.c >= rule.actions, `${a.c}`, `${rule.actions}+`);
  }
  ok('الإنذارات الرسمية', warnCount <= rule.maxWarnings, `${warnCount}`, `أقصى ${rule.maxWarnings}`);
  ok('فترة التبريد', !cd, cd ? `حتى ${cd.until}` : 'لا يوجد', 'لا يوجد');
  ok('الحالة', staff.status === 'active' || staff.status === 'probation', staff.status, 'active');

  return { rule, eligible: checks.every(c => c.pass), checks, score: sc.score, points: pts, months };
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

module.exports = { nextPromotion, evaluate, pendingRequest, createRequest, listPending, getRequest, review };
