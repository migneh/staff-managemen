'use strict';
const { getDb } = require('../database');
const { POINTS, COOLDOWNS } = require('../constants');
const { addDays, today } = require('../utils');

function valueFor(key, team) {
  const def = POINTS[key];
  if (!def) return 0;
  if (def.all !== undefined) return def.all;
  return def[team] ?? 0;
}

/**
 * إضافة نقاط ترقية حسب مفتاح السبب.
 * @returns {number} النقاط المضافة
 */
function add(userId, key, team, { reason, refType, refId, addedBy, override } = {}) {
  const pts = override ?? valueFor(key, team);
  if (!pts) return 0;
  getDb().prepare(`INSERT INTO promotion_points (user_id, points, reason_key, reason, ref_type, ref_id, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, pts, key, reason || POINTS[key]?.label || key, refType || null, refId != null ? String(refId) : null, addedBy || null);
  return pts;
}

function total(userId, since) {
  const sql = since
    ? 'SELECT COALESCE(SUM(points),0) t FROM promotion_points WHERE user_id = ? AND created_at >= ?'
    : 'SELECT COALESCE(SUM(points),0) t FROM promotion_points WHERE user_id = ?';
  return getDb().prepare(sql).get(...(since ? [userId, since] : [userId])).t;
}

function history(userId, limit = 15) {
  return getDb().prepare('SELECT * FROM promotion_points WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);
}

/** تصفير نقاط الرتبة بعد ترقية (النقاط تُحتسب لكل رتبة) */
function resetForNewRank(userId, reason) {
  const t = total(userId);
  if (t !== 0) add(userId, 'rank_reset', null, { override: -t, reason: reason || 'تصفير النقاط بعد الترقية' });
}

// ===== فترات التبريد =====
function setCooldown(userId, type, days) {
  const until = addDays(today(), days ?? COOLDOWNS[type]);
  getDb().prepare('INSERT INTO promotion_cooldowns (user_id, cooldown_type, until) VALUES (?, ?, ?)').run(userId, type, until);
  return until;
}

function activeCooldown(userId) {
  return getDb().prepare(`SELECT * FROM promotion_cooldowns WHERE user_id = ? AND until > ? ORDER BY until DESC LIMIT 1`).get(userId, today()) || null;
}

module.exports = { add, total, history, valueFor, resetForNewRank, setCooldown, activeCooldown };
