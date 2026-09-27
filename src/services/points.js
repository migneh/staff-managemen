'use strict';
const { getDb } = require('../database');
const { addDays } = require('../utils');

const VALUES = {
  ticket_closed: { support: 2, moderation: 0 },
  ticket_rating_5: { support: 5, moderation: 0 },
  mod_action: { moderation: 3, support: 0 },
  formal_warning: { support: -20, moderation: -20 },
  best_of_month: { support: 5, moderation: 5 },
  helped_newbie: { support: 2, moderation: 2 },
};
function currentEpoch(userId) {
  return getDb().prepare('SELECT COALESCE(MAX(rank_epoch), 1) epoch FROM promotion_points WHERE user_id = ?').get(userId).epoch;
}
function add(userId, reasonKey, team, options = {}) {
  const points = options.points ?? VALUES[reasonKey]?.[team] ?? 0;
  const epoch = currentEpoch(userId);
  getDb().prepare(`INSERT INTO promotion_points (user_id, points, reason_key, reason, ref_type, ref_id, added_by, rank_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, points, reasonKey, options.reason || reasonKey, options.refType || null, options.refId == null ? null : String(options.refId), options.addedBy || null, epoch);
  return points;
}
function total(userId, _period = null, { allEpochs = false } = {}) {
  const sql = `SELECT COALESCE(SUM(points), 0) total FROM promotion_points WHERE user_id = ? ${allEpochs ? '' : 'AND rank_epoch = ?'}`;
  const row = getDb().prepare(sql).get(...(allEpochs ? [userId] : [userId, currentEpoch(userId)]));
  return row.total;
}
function history(userId, limit = 20) {
  const epoch = currentEpoch(userId);
  return getDb().prepare('SELECT *, rank_epoch = ? AS counts FROM promotion_points WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(epoch, userId, Math.min(Math.max(Number(limit) || 20, 1), 200));
}
function setCooldown(userId, type, days = 30) {
  const until = addDays(new Date().toISOString().slice(0, 10), days);
  getDb().prepare('INSERT INTO promotion_cooldowns (user_id, cooldown_type, until) VALUES (?, ?, ?)').run(userId, type, until);
  return getDb().prepare('SELECT * FROM promotion_cooldowns WHERE id = last_insert_rowid()').get();
}
function activeCooldown(userId) {
  return getDb().prepare("SELECT * FROM promotion_cooldowns WHERE user_id = ? AND until >= date('now') ORDER BY until DESC LIMIT 1").get(userId) || null;
}
function resetForNewRank(userId) {
  const previousTotal = total(userId);
  const epoch = currentEpoch(userId) + 1;
  getDb().prepare(`INSERT INTO promotion_points (user_id, points, reason_key, reason, rank_epoch) VALUES (?, ?, 'rank_reset', 'بدء عصر رتبة جديد', ?)`)
    .run(userId, 0, epoch);
  return { previousTotal, epoch };
}
module.exports = { add, total, history, setCooldown, activeCooldown, resetForNewRank };
