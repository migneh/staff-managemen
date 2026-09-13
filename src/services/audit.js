'use strict';
const { getDb } = require('../database');
const { nowIso } = require('../utils');

function record({ action, actorId = null, targetId = null, details = null, channelId = null }) {
  const payload = details == null ? null : typeof details === 'string' ? details : JSON.stringify(details);
  const result = getDb().prepare(`INSERT INTO audit_logs (action, actor_id, target_id, details, channel_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(action, actorId, targetId, payload, channelId, nowIso());
  return result.lastInsertRowid;
}

function list({ actorId, targetId, limit = 15 } = {}) {
  let sql = 'SELECT * FROM audit_logs WHERE 1=1';
  const params = [];
  if (actorId) { sql += ' AND actor_id = ?'; params.push(actorId); }
  if (targetId) { sql += ' AND target_id = ?'; params.push(targetId); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(Math.min(Math.max(Number(limit) || 15, 1), 50));
  return getDb().prepare(sql).all(...params);
}

function parseDetails(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
}

module.exports = { record, list, parseDetails };
