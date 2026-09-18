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

/** عصر النقاط الحالي للعضو — كل رتبة عصر مستقل (راجع ROADMAP 2.2) */
function currentEpoch(userId) {
  return getDb().prepare('SELECT COALESCE(rank_epoch, 1) e FROM staff_members WHERE user_id = ?').get(userId)?.e ?? 1;
}

/**
 * إضافة نقاط ترقية حسب مفتاح السبب. تُوسم دائماً بعصر الرتبة الحالي، فيمكن
 * حساب «نقاط هذه الرتبة» بلا صف سلبي مزيف ولا فقدان أي سجل.
 * @returns {number} النقاط المضافة
 */
function add(userId, key, team, { reason, refType, refId, addedBy, override } = {}) {
  const pts = override ?? valueFor(key, team);
  if (!pts) return 0;
  try {
    getDb().prepare(`INSERT INTO promotion_points (user_id, points, reason_key, reason, ref_type, ref_id, added_by, rank_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, pts, key, reason || POINTS[key]?.label || key, refType || null, refId != null ? String(refId) : null, addedBy || null, currentEpoch(userId));
  } catch (e) {
    // مرجع مكرر (نفس المهمة/التكت/الأسبوع) — لا نحتسبها مرتين.
    if (String(e.message).includes('UNIQUE')) return 0;
    throw e;
  }
  return pts;
}

/**
 * مجموع النقاط. افتراضياً **لعصر الرتبة الحالي فقط** — وهذا ما يعادل «تصفير
 * النقاط بعد الترقية» لكن بسجل كامل قابل للتدقيق. مرّر allEpochs لحساب الإجمالي التاريخي.
 */
function total(userId, since, { allEpochs = false } = {}) {
  const where = ['user_id = ?'];
  const params = [userId];
  if (!allEpochs) { where.push('COALESCE(rank_epoch, 1) = ?'); params.push(currentEpoch(userId)); }
  if (since) { where.push('created_at >= ?'); params.push(since); }
  return getDb().prepare(`SELECT COALESCE(SUM(points),0) t FROM promotion_points WHERE ${where.join(' AND ')}`).get(...params).t;
}

/** تاريخ النقاط مع العصر وحالة الاحتساب (هل تُحسب في الرتبة الحالية؟) */
function history(userId, limit = 15) {
  const epoch = currentEpoch(userId);
  return getDb().prepare('SELECT * FROM promotion_points WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit)
    .map(row => ({ ...row, epoch, counts: (row.rank_epoch ?? 1) === epoch }));
}

/**
 * بدء عصر نقاط جديد. كان يُنفَّذ بصف سلبي (-total) يلوّث السجل ويصعب تدقيقه.
 * الآن نُحرّك rank_epoch فقط، فتبقى كل النقاط مكتوبة ويُحسب منها ما يخص الرتبة الحالية.
 */
function resetForNewRank(userId) {
  const before = total(userId);
  getDb().prepare(`UPDATE staff_members SET rank_epoch = COALESCE(rank_epoch, 1) + 1, updated_at = datetime('now') WHERE user_id = ?`).run(userId);
  const db = getDb();
  // اربط أي صف قديم بلا عصر بالعصر السابق حتى لا تتسرب نقاط الرتبة القديمة
  db.prepare(`UPDATE promotion_points SET rank_epoch = ? WHERE user_id = ? AND rank_epoch IS NULL`).run(currentEpoch(userId) - 1, userId);
  return { previousTotal: before, epoch: currentEpoch(userId) };
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

module.exports = { add, total, history, valueFor, resetForNewRank, setCooldown, activeCooldown, currentEpoch };
