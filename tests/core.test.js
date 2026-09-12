'use strict';
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { openMemoryDb, getDb } = require('../src/database');
const activity = require('../src/services/activity');
const points = require('../src/services/points');
const score = require('../src/services/score');
const promo = require('../src/services/promotions');
const faq = require('../src/services/faq');
const reports = require('../src/services/reports');
const { resolveComponent } = require('../src/commands');

function seedStaff(id, team, rank, extra = {}) {
  const db = getDb();
  db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since, last_activity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, 'u' + id, team, rank, extra.status || 'active', extra.since || '2025-01-01 00:00:00', extra.since || '2025-01-01 00:00:00', extra.last || '2026-09-12 00:00:00');
  return db.prepare('SELECT * FROM staff_members WHERE user_id = ?').get(id);
}

beforeEach(() => openMemoryDb());

describe('فلتر السبام', () => {
  test('يرفض الرسائل القصيرة والإيموجي والرموز والتكرار', () => {
    assert.equal(activity.spamReason('hi'), 'short');
    assert.equal(activity.spamReason('😀😀😀😀😀😀😀😀'), 'emoji_only');
    assert.equal(activity.spamReason('!!!???...---'), 'symbols_only');
    assert.equal(activity.spamReason('aaaaaaaaaaaa'), 'repeated_char');
    assert.equal(activity.spamReason('السلام عليكم ورحمة الله'), null);
  });
  test('يتجاهل الرسالة المكررة خلال دقيقتين ويطبق حد 20 رسالة عامة', () => {
    const ch = { id: '1', name: 'general' };
    assert.equal(activity.record('u1', ch, 'رسالة طبيعية طويلة').counted, true);
    assert.equal(activity.record('u1', ch, 'رسالة طبيعية طويلة').reason, 'duplicate');
    for (let k = 0; k < 19; k++) activity.record('u1', ch, `رسالة مختلفة رقم ${k} هنا`);
    assert.equal(activity.record('u1', ch, 'رسالة إضافية بعد الحد').reason, 'daily_cap');
    assert.equal(activity.record('u1', { id: '2', name: 'ticket-0001' }, 'قنوات التكتات بلا حد').counted, true);
  });
  test('يصنف قنوات التكتات بالاسم والوزن الصحيح', () => {
    assert.equal(activity.classifyChannel({ id: 'x', name: 'ticket-0042' }), 'ticket');
    assert.equal(activity.classifyChannel({ id: 'x', name: 'chat' }), 'general');
  });
});

describe('النقاط والتبريد', () => {
  test('يحسب النقاط حسب الفريق', () => {
    assert.equal(points.add('u1', 'ticket_closed', 'support'), 2);
    assert.equal(points.add('u1', 'ticket_rating_5', 'support'), 5);
    assert.equal(points.add('u1', 'mod_action', 'support'), 0);
    assert.equal(points.add('u2', 'mod_action', 'moderation'), 3);
    assert.equal(points.add('u1', 'formal_warning', 'support'), -20);
    assert.equal(points.total('u1'), -13);
  });
  test('فترة التبريد تُكتشف', () => {
    assert.equal(points.activeCooldown('u1'), null);
    points.setCooldown('u1', 'rejected');
    assert.equal(points.activeCooldown('u1').cooldown_type, 'rejected');
  });
});

describe('Score', () => {
  test('Helper يُحسب بدون تكتات', () => {
    const s = seedStaff('h1', 'support', 'Helper');
    const r = score.compute(s, { messages: 200, activeDays: 26, tickets: 0 });
    assert.equal(r.factors.length, 4);
    assert.equal(r.factors[0].pts, 25);
    assert.equal(r.factors[1].pts, 25);
    assert.equal(r.score, 70); // 25+25+10+10 (تقييمات افتراضية)
  });
  test('Support يُحسب بالتكتات والسرعة', () => {
    const s = seedStaff('s1', 'support', 'Support');
    const r = score.compute(s, { messages: 150, activeDays: 21, tickets: 50, avgDuration: 4, avgRating: 4.6 });
    assert.equal(r.score, 30 + 25 + 20 + 16);
    assert.equal(score.grade(r.score), 'ممتاز');
  });
  test('الإشراف يُحسب بالمخالفات', () => {
    const s = seedStaff('m1', 'moderation', 'Moderator');
    const r = score.compute(s, { messages: 10, activeDays: 5, actions: 60 });
    assert.equal(r.factors[0].pts, 30);
    assert.equal(r.score, 30 + 10 + 5 + 4);
  });
});

describe('الترقيات', () => {
  test('يقيّم كل الشروط بدقة', () => {
    const s = seedStaff('t1', 'moderation', 'Trial Moderator', { since: '2025-01-01 00:00:00' });
    let ev = promo.evaluate(s);
    assert.equal(ev.rule.to, 'Moderator');
    assert.equal(ev.eligible, false);
    const db = getDb();
    for (let k = 0; k < 60; k++) db.prepare(`INSERT INTO mod_actions (moderator_id, target_id, action_type, reason) VALUES (?, 'x', 'warn', 'r')`).run('t1');
    for (let k = 0; k < 200; k++) db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day) VALUES ('t1', '1', 'staff', 0.25, ?)`).run(`2026-09-${String((k % 28) + 1).padStart(2, '0')}`);
    points.add('t1', 'best_of_month', 'moderation');
    points.add('t1', 'helped_newbie', 'moderation');
    points.add('t1', 'helped_newbie', 'moderation');
    db.prepare(`UPDATE staff_members SET response_speed = 25 WHERE user_id = 't1'`).run();
    ev = promo.evaluate(s);
    assert.ok(ev.score >= 60, `score ${ev.score}`);
    assert.equal(ev.eligible, true, JSON.stringify(ev.checks));
    // إنذار رسمي يمنع الترقية
    db.prepare(`INSERT INTO warnings (user_id, warning_type, reason, issued_by) VALUES ('t1', 'first', 'r', 'b')`).run();
    ev = promo.evaluate(s);
    assert.equal(ev.eligible, false);
    assert.equal(ev.checks.find(c => c.label === 'الإنذارات الرسمية').pass, false);
  });
  test('Boss لا يملك ترقية', () => {
    const s = seedStaff('b1', 'support', 'Boss');
    assert.equal(promo.evaluate(s).rule, null);
  });
});

describe('FAQ', () => {
  test('إضافة/تعديل/حذف مع التاريخ ونظام القراءة', () => {
    const e = faq.add({ categoryId: 1, title: 'قانون', content: 'محتوى', important: true, userId: 'a' });
    assert.equal(faq.unreadFor('u1').length, 1);
    faq.acknowledge(e.id, 'u1', e.version);
    assert.equal(faq.hasRead(e.id, 'u1'), true);
    assert.equal(faq.unreadFor('u1').length, 0);
    const e2 = faq.edit(e.id, { title: 'قانون معدل', userId: 'a' });
    assert.equal(e2.version, 2);
    assert.equal(faq.hasRead(e.id, 'u1'), false, 'التعديل يتطلب قراءة جديدة');
    assert.equal(faq.history(e.id).length, 2);
    assert.equal(faq.search('معدل').length, 1);
    faq.remove(e.id, 'a');
    assert.equal(faq.get(e.id), null);
    assert.equal(faq.history(e.id).length, 3);
  });
});

describe('التقارير والـ Leaderboard', () => {
  test('يستبعد Boss والمجازين', () => {
    seedStaff('b', 'support', 'Boss');
    seedStaff('l', 'support', 'Support', { status: 'on_leave' });
    seedStaff('s', 'support', 'Support');
    seedStaff('m', 'moderation', 'Admin');
    const lb = reports.leaderboard('support');
    assert.deepEqual(lb.map(r => r.staff.user_id), ['s']);
    assert.equal(reports.leaderboard().length, 2);
    const d = reports.daily();
    assert.equal(d.total, 4);
    assert.equal(d.onLeave, 1);
  });
});

describe('راوتر المكونات', () => {
  test('يفكك customId مع المعاملات', () => {
    const r = resolveComponent('faq:ack:12');
    assert.ok(r);
    assert.deepEqual(r.args, ['12']);
    assert.ok(resolveComponent('modaction:log:ban'));
    assert.equal(resolveComponent('unknown:x'), null);
  });
});
