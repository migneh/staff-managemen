'use strict';
const { getDb } = require('../database');
const { resolveStaff, TEAM_RANKS } = require('./permissions');
const { nowIso } = require('../utils');
const settings = require('./settings');

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
    const initialStatus = info.team === 'general_management' ? 'active' : 'probation';
    db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(member.id, member.user?.username || member.displayName, info.team, info.rank, initialStatus, nowIso(), nowIso());
    if (initialStatus === 'probation') {
      try { require('./tasks').ensureOnboarding(member.id); } catch (e) { console.error('فشل إنشاء مهام التأهيل:', e.message); }
    }
    return { ...get(member.id), isNew: true };
  }
  const updates = {};
  const username = member.user?.username || existing.username;
  if (existing.username !== username) updates.username = username;
  if (existing.team !== info.team || existing.rank !== info.rank) {
    updates.team = info.team;
    updates.rank = info.rank;
    updates.rank_since = nowIso();
    // الإدارة العامة لا تدخل فترة تجريبية. تغيير الرتبة داخل الفريقين يعيدها فقط عند العضو الجديد.
    if (existing.status === 'resigned') updates.status = info.team === 'general_management' ? 'active' : 'probation';
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
  getDb().prepare('UPDATE staff_members SET team = ?, rank = ?, rank_since = ?, status = ?, updated_at = ? WHERE user_id = ?')
    .run(team, rank, nowIso(), 'active', nowIso(), userId);
}

/** تعديل رتب الديسكورد فعلياً عند الترقية أو التعيين */
async function applyRankRoles(member, team, newRank) {
  const ranks = TEAM_RANKS[team] || [];
  const roleMap = settings.roles()[team] || {};
  const newRoleId = roleMap[newRank];
  if (!newRoleId) return false;
  const toRemove = ranks.map(r => roleMap[r.name]).filter(id => id && id !== newRoleId && member.roles.cache.has(id));
  try {
    if (toRemove.length) await member.roles.remove(toRemove, 'تحديث رتبة عبر Staff Manager');
    await member.roles.add(newRoleId, 'تحديث رتبة عبر Staff Manager');
    return true;
  } catch (e) { console.error('فشل تعديل الرتب:', e.message); return false; }
}

/** إزالة رتب فريق محدد */
async function removeTeamRoles(member, team) {
  const roleMap = settings.roles()[team] || {};
  const ids = Object.values(roleMap).filter(id => id && member.roles.cache.has(id));
  if (!ids.length) return true;
  try { await member.roles.remove(ids, 'إزالة من الفريق عبر Staff Manager'); return true; } catch (e) { console.error('فشل إزالة رتب الفريق:', e.message); return false; }
}

/** إزالة كل الرتب الإدارية (عند الاستقالة أو إلغاء تعيين الإدارة العامة) */
async function removeAllStaffRoles(member) {
  const ids = new Set();
  for (const team of Object.keys(TEAM_RANKS)) for (const id of Object.values(settings.roles()[team] || {})) {
    if (id && member.roles.cache.has(id)) ids.add(id);
  }
  if (!ids.size) return true;
  try { await member.roles.remove([...ids], 'إزالة الرتب الإدارية عبر Staff Manager'); return true; } catch { return false; }
}

module.exports = {
  get, all, ensure, setStatus, update, touchActivity, setRank,
  applyRankRoles, removeTeamRoles, removeAllStaffRoles,
};
