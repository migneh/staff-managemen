'use strict';
const { getDb } = require('../database');
const staffService = require('./staff');
const score = require('./score');
const points = require('./points');
const { hoursSince } = require('../utils');
const { LEVELS } = require('../constants');
const { rankInfo } = require('./permissions');

/** تقرير فردي كامل */
function individual(staff, days = 30) {
  const db = getDb();
  const raw = score.monthlyRaw(staff.user_id, days);
  const sc = score.compute(staff, raw);
  const warns = db.prepare(`SELECT warning_type, COUNT(*) c FROM warnings WHERE user_id = ? AND created_at >= datetime('now', ?) GROUP BY warning_type`).all(staff.user_id, `-${days} days`);
  const absentDays = Math.max(0, days - raw.activeDays - raw.leaveDays);
  return {
    staff, raw, score: sc.score, factors: sc.factors, grade: score.grade(sc.score),
    points: points.total(staff.user_id),
    warnings: warns, absentDays,
    lastActivityHours: hoursSince(staff.last_activity),
  };
}

/** ملخص فريق */
function team(teamKey, days = 30) {
  const members = staffService.all({ team: teamKey });
  return members.map(m => individual(m, days));
}

/** Leaderboard (يستبعد Boss والمجازين والموقوفين) */
function leaderboard(teamKey, days = 30) {
  const members = staffService.all(teamKey ? { team: teamKey } : {});
  return members
    .filter(m => ['support', 'moderation'].includes(m.team))
    .filter(m => !(m.team === 'support' && rankInfo('support', m.rank)?.level >= LEVELS.BOSS))
    .filter(m => !['on_leave', 'suspended', 'resigned'].includes(m.status))
    .map(m => {
      const r = individual(m, days);
      return { ...r, primary: m.team === 'support' ? r.raw.tickets : r.raw.actions };
    })
    .sort((a, b) => b.score - a.score || b.points - a.points || b.primary - a.primary);
}

/** التقرير اليومي */
function daily() {
  const db = getDb();
  const all = staffService.all();
  const active = all.filter(m => hoursSince(m.last_activity) <= 24).length;
  const absent = all.filter(m => !['on_leave', 'suspended'].includes(m.status) && hoursSince(m.last_activity) > 72);
  const onLeave = all.filter(m => m.status === 'on_leave').length;
  const tickets = db.prepare(`SELECT COUNT(*) c FROM ticket_metrics WHERE closed_at >= datetime('now', '-1 day')`).get().c;
  const actions = db.prepare(`SELECT COUNT(*) c FROM mod_actions WHERE created_at >= datetime('now', '-1 day')`).get().c;
  const pending = {
    leaves: db.prepare(`SELECT COUNT(*) c FROM leave_requests WHERE status = 'pending'`).get().c,
    resignations: db.prepare(`SELECT COUNT(*) c FROM resignations WHERE status = 'pending'`).get().c,
    promotions: db.prepare(`SELECT COUNT(*) c FROM promotion_requests WHERE status = 'pending'`).get().c,
  };
  return { total: all.length, active, absent, onLeave, tickets, actions, pending };
}

function save(type, period, data) {
  getDb().prepare('INSERT INTO saved_reports (report_type, period, data) VALUES (?, ?, ?)').run(type, period, JSON.stringify(data));
}
function lastSaved(type, period) {
  const r = getDb().prepare('SELECT * FROM saved_reports WHERE report_type = ? AND period = ? ORDER BY id DESC LIMIT 1').get(type, period);
  return r ? JSON.parse(r.data) : null;
}

module.exports = { individual, team, leaderboard, daily, save, lastSaved };
