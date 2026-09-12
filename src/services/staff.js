'use strict';
const { getDb } = require('../database');
const { resolveStaff } = require('./permissions');
const { nowIso } = require('../utils');
const settings = require('./settings');
const { SUPPORT_RANKS, MOD_RANKS } = require('../constants');

function get(userId) {
  return getDb().prepare('SELECT * FROM staff_members WHERE user_id = ?').get(userId) || null;
}

function all({ team, includeResigned = false } = {}) {
  let sql = 'SELECT * FROM staff_members WHERE 1=1';
  const params = [];
  if (!includeResigned) sql += " AND status != 'resigned'";
  if (team) { sql += ' AND team = ?'; params.push(team); }
  sql += ' ORDER BY team, rank_since';
  return getDb().prepare(sql).all(...params);
}

/**
 * تسجيل/مزامنة الإداري تلقائياً من رتب الديسكورد.
 * يُستدعى عند أول رسالة أو أي تفاعل.
 */
function ensure(member) {
  const info = resolveStaff(member);
  if (!info) return null;
  const db = getDb();
  const existing = get(member.id);
  if (!existing) {
    db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since)
      VALUES (?, ?, ?, ?, 'probation', ?, ?)`)
      .run(member.id, member.user?.username || member.displayName, info.team, info.rank, nowIso(), nowIso());
    return { ...get(member.id), isNew: true };
  }
  const updates = {};
  if (existing.username !== (member.user?.username || existing.username)) updates.username = member.user.username;
  if (existing.team !== info.team || existing.rank !== info.rank) {
    updates.team = info.team;
    updates.rank = info.rank;
    updates.rank_since = nowIso();
  }
  if (existing.status === 'resigned') { updates.status = 'active'; updates.joined_at = nowIso(); updates.rank_since = nowIso(); }
  if (Object.keys(updates).length) {
    const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE staff_members SET ${sets}, updated_at = ? WHERE user_id = ?`).run(...Object.values(updates), nowIso(), member.id);
    return get(member.id);
  }
  return existing;
}

function setStatus(userId, status) {
  getDb().prepare('UPDATE staff_members SET status = ?, updated_at = ? WHERE user_id = ?').run(status, nowIso(), userId);
}

function update(userId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE staff_members SET ${sets}, updated_at = ? WHERE user_id = ?`).run(...keys.map(k => fields[k]), nowIso(), userId);
}

function touchActivity(userId) {
  getDb().prepare(`UPDATE staff_members SET last_activity = ?, absence_alert_level = 0,
    status = CASE WHEN status = 'inactive' THEN 'active' ELSE status END, updated_at = ? WHERE user_id = ?`)
    .run(nowIso(), nowIso(), userId);
}

function setRank(userId, team, rank) {
  getDb().prepare('UPDATE staff_members SET team = ?, rank = ?, rank_since = ?, updated_at = ? WHERE user_id = ?')
    .run(team, rank, nowIso(), nowIso(), userId);
}

/** تعديل رتب الديسكورد فعلياً عند الترقية */
async function applyRankRoles(member, team, newRank) {
  const ranks = team === 'support' ? SUPPORT_RANKS : MOD_RANKS;
  const roleMap = settings.roles()[team] || {};
  const newRoleId = roleMap[newRank];
  if (!newRoleId) return false;
  const toRemove = ranks.map(r => roleMap[r.name]).filter(id => id && id !== newRoleId && member.roles.cache.has(id));
  try {
    if (toRemove.length) await member.roles.remove(toRemove, 'ترقية عبر Staff Manager');
    await member.roles.add(newRoleId, 'ترقية عبر Staff Manager');
    return true;
  } catch (e) { console.error('فشل تعديل الرتب:', e.message); return false; }
}

/** إزالة كل الرتب الإدارية (عند الاستقالة) */
async function removeAllStaffRoles(member) {
  const ids = [];
  for (const team of ['support', 'moderation']) for (const id of Object.values(settings.roles()[team] || {})) {
    if (id && member.roles.cache.has(id)) ids.push(id);
  }
  if (!ids.length) return true;
  try { await member.roles.remove(ids, 'استقالة مقبولة عبر Staff Manager'); return true; } catch { return false; }
}

module.exports = { get, all, ensure, setStatus, update, touchActivity, setRank, applyRankRoles, removeAllStaffRoles };
