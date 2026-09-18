'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { openMemoryDb, getDb } = require('../src/database');
const score = require('../src/services/score');
const load = require('../src/services/load');
const reports = require('../src/services/reports');
const points = require('../src/services/points');
const taskService = require('../src/services/tasks');
const health = require('../src/health');

function seedStaff(id, team, rank, status = 'active') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status) VALUES (?, ?, ?, ?, ?)`)
    .run(id, id, team, rank, status);
  return getDb().prepare('SELECT * FROM staff_members WHERE user_id = ?').get(id);
}

beforeEach(() => openMemoryDb());

describe('المرحلة 3 — شفافية وتقارير العمل', () => {
  test('يحسب اتجاه الأسبوع من نافذة سابقة لا من نفس البيانات', () => {
    const staff = seedStaff('trend', 'support', 'Support');
    const db = getDb();
    db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day, created_at)
      VALUES ('trend', '1', 'staff', 1, date('now'), datetime('now'))`).run();
    db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day, created_at)
      VALUES ('trend', '1', 'staff', 1, date('now', '-10 days'), datetime('now', '-10 days'))`).run();
    const current = score.monthlyRaw(staff.user_id, 7);
    const previous = score.monthlyRaw(staff.user_id, 7, 7);
    assert.equal(current.messages, 1);
    assert.equal(previous.messages, 1);
    const trend = reports.personalTrend(staff);
    assert.equal(trend.currentActiveDays, 1);
    assert.equal(trend.previousActiveDays, 1);
  });

  test('يحفظ اعتراض النقاط كمهمة إدارة ولا يظهر كمهمة عادية للعضو', () => {
    seedStaff('appeal', 'support', 'Support');
    const point = points.add('appeal', 'ticket_closed', 'support', { refType: 'ticket', refId: 'T-1', addedBy: 'manager' });
    assert.equal(point, 2);
    const history = points.history('appeal', 10);
    assert.equal(history[0].reason_key, 'ticket_closed');
    const task = taskService.create({ userId: 'appeal', title: 'اعتراض على حركة النقاط #1', description: 'سبب', taskType: 'points_appeal', assignedBy: 'appeal' });
    assert.equal(taskService.listByType('points_appeal').length, 1);
    assert.equal(taskService.pendingCount('appeal'), 0);
    assert.equal(taskService.list('appeal').length, 0);
    assert.equal(taskService.complete(task.id, 'appeal'), null);
  });

  test('يحسب حمل الفريق من التكتات والإجراءات ويستبعد التجربة', () => {
    seedStaff('s1', 'support', 'Support');
    seedStaff('s2', 'support', 'Support');
    seedStaff('trial', 'support', 'Helper', 'probation');
    const db = getDb();
    const insert = db.prepare(`INSERT INTO ticket_metrics (ticket_id, ticket_owner, claimer, closer, rating, duration, logged_by, closed_at)
      VALUES (?, 'owner', ?, ?, 5, ?, 'manager', datetime('now', '-1 day'))`);
    insert.run('t1', 's1', 's1', 12);
    insert.run('t2', 's1', 's1', 8);
    const rows = load.teamLoad('support', 7);
    assert.deepEqual(rows.map(r => r.staff.user_id), ['s1', 's2']);
    assert.equal(rows[0].work.closed, 2);
    assert.equal(rows[0].work.avgDuration, 10);
    assert.deepEqual(load.fairness(rows).idle, ['s2']);
  });
});

describe('المرحلة 4 — التشغيل والمراقبة', () => {
  test('يعرض healthz وmetrics حالة المهام وقاعدة البيانات', () => {
    const scheduler = { status: () => ({ daily: { finishedAt: '2026-09-18 09:00:00', ok: true, error: null } }) };
    const snapshot = health.snapshot(scheduler);
    assert.equal(snapshot.status, 'ok');
    assert.equal(snapshot.database.sizeMb, 0);
    assert.equal(snapshot.failedJobs.length, 0);
    assert.match(health.metrics(scheduler), /staff_manager_uptime_seconds/);
    assert.match(health.metrics(scheduler), /job_last_run_ok\{job="daily"\} 1/);
  });
});
