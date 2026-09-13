'use strict';
const { getDb } = require('../database');
const staffService = require('./staff');
const { today } = require('../utils');

const APPROVED = "status = 'approved'";
const PENDING_OR_APPROVED = "status IN ('pending', 'approved')";

function concurrentApproved(start, end, excludeId = null) {
  const params = [end, start];
  let sql = `SELECT COUNT(DISTINCT user_id) c FROM leave_requests WHERE ${APPROVED} AND start_date <= ? AND end_date >= ?`;
  if (excludeId != null) { sql += ' AND id != ?'; params.push(Number(excludeId)); }
  return getDb().prepare(sql).get(...params).c;
}

function userHasOverlap(userId, start, end, { excludeId = null, includePending = true } = {}) {
  const params = [userId, end, start];
  let sql = `SELECT * FROM leave_requests WHERE user_id = ? AND ${includePending ? PENDING_OR_APPROVED : APPROVED}
    AND start_date <= ? AND end_date >= ?`;
  if (excludeId != null) { sql += ' AND id != ?'; params.push(Number(excludeId)); }
  return getDb().prepare(`${sql} ORDER BY start_date LIMIT 1`).get(...params) || null;
}

function approvedForUser(userId, { onOrAfter = today(), excludeId = null } = {}) {
  const params = [userId, onOrAfter];
  let sql = `SELECT * FROM leave_requests WHERE user_id = ? AND ${APPROVED} AND end_date >= ?`;
  if (excludeId != null) { sql += ' AND id != ?'; params.push(Number(excludeId)); }
  return getDb().prepare(`${sql} ORDER BY start_date`).all(...params);
}

function activeForUser(userId, date = today()) {
  return getDb().prepare(`SELECT * FROM leave_requests WHERE user_id = ? AND ${APPROVED}
    AND start_date <= ? AND end_date >= ? ORDER BY end_date DESC`).all(userId, date, date);
}

function hasApprovedCover(userId, date = today(), excludeId = null) {
  return approvedForUser(userId, { onOrAfter: date, excludeId }).some(r => r.start_date <= date && r.end_date >= date);
}

async function syncVacationRole(member, date = today()) {
  if (!member) return { ok: true, skipped: true };
  const shouldHave = hasApprovedCover(member.id, date) || approvedForUser(member.id, { onOrAfter: date }).some(r => r.start_date > date);
  return shouldHave ? staffService.addVacationRole(member) : staffService.removeVacationRole(member);
}

function markReminder(id, current, key) {
  const sent = new Set(String(current || '').split(',').filter(Boolean));
  if (sent.has(key)) return false;
  sent.add(key);
  getDb().prepare('UPDATE leave_requests SET reminders_sent = ? WHERE id = ?').run([...sent].join(','), id);
  return true;
}

module.exports = {
  concurrentApproved, userHasOverlap, approvedForUser, activeForUser,
  hasApprovedCover, syncVacationRole, markReminder,
};
