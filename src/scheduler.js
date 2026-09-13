'use strict';
const cron = require('node-cron');
const { getDb } = require('./database');
const staffService = require('./services/staff');
const reports = require('./services/reports');
const points = require('./services/points');
const score = require('./services/score');
const { ABSENCE } = require('./constants');
const { embed, COLORS, sendToChannel, dm, hoursSince, today, addDays } = require('./utils');
const reportCmds = require('./commands/reports');
const backup = require('./services/backup');

const EXEMPT = ['on_leave', 'suspended', 'resigned'];

// ===== فاحص الغياب =====
async function checkAbsence(client) {
  for (const m of staffService.all()) {
    if (EXEMPT.includes(m.status)) continue;
    if (m.status === 'probation' && m.probation_exempt) continue;
    const h = hoursSince(m.last_activity || m.joined_at);
    if (h >= ABSENCE.staffAlertHours && m.absence_alert_level < 2) {
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('🚨 غياب 96 ساعة', `<@${m.user_id}> (${m.rank}) بدون نشاط منذ **${Math.floor(h)}** ساعة.`, COLORS.danger)] });
      staffService.update(m.user_id, { absence_alert_level: 2, status: m.status === 'active' ? 'inactive' : m.status });
    } else if (h >= ABSENCE.dmHours && m.absence_alert_level < 1) {
      await dm(client, m.user_id, { embeds: [embed('⏰ تنبيه غياب', `لم نرصد أي نشاط منك منذ **72 ساعة**. إذا كان لديك ظرف، قدّم طلب إجازة عبر \`/request-leave\`.`, COLORS.warning)] });
      staffService.update(m.user_id, { absence_alert_level: 1, status: m.status === 'active' ? 'inactive' : m.status });
    }
  }
}

// ===== الإجازات: تفعيل / إنهاء / تذكيرات =====
async function processLeaves(client) {
  const db = getDb();
  const t = today();
  const rows = db.prepare(`SELECT * FROM leave_requests WHERE status = 'approved'`).all();
  for (const r of rows) {
    const sent = new Set(r.reminders_sent.split(',').filter(Boolean));
    const mark = (k) => { sent.add(k); db.prepare('UPDATE leave_requests SET reminders_sent = ? WHERE id = ?').run([...sent].join(','), r.id); };
    const s = staffService.get(r.user_id);
    if (!s) continue;

    if (r.start_date === addDays(t, 1) && !sent.has('start')) { await dm(client, r.user_id, { embeds: [embed('🏖️ تذكير', `إجازتك تبدأ غداً (${r.start_date}).`, COLORS.info)] }); mark('start'); }
    if (r.start_date <= t && r.end_date >= t && s.status !== 'on_leave' && s.status !== 'resigned') staffService.setStatus(r.user_id, 'on_leave');
    if (r.end_date === addDays(t, 1) && !sent.has('end')) { await dm(client, r.user_id, { embeds: [embed('🏖️ تذكير', `إجازتك تنتهي غداً (${r.end_date}). نرجو العودة للنشاط.`, COLORS.info)] }); mark('end'); }
    if (r.end_date < t) {
      db.prepare(`UPDATE leave_requests SET status = 'ended' WHERE id = ?`).run(r.id);
      if (s.status === 'on_leave') staffService.update(r.user_id, { status: 'active', last_activity: new Date().toISOString().replace('T', ' ').slice(0, 19), absence_alert_level: 0 });
    }
  }
  // تنبيه بعد النهاية بـ 24 ساعة إن لم يرجع
  const ended = db.prepare(`SELECT * FROM leave_requests WHERE status = 'ended' AND end_date = ? AND reminders_sent NOT LIKE '%overdue%'`).all(addDays(t, -2));
  for (const r of ended) {
    const s = staffService.get(r.user_id);
    if (s && s.last_activity && s.last_activity.slice(0, 10) <= r.end_date) {
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('⚠️ لم يعد من الإجازة', `<@${r.user_id}> انتهت إجازته في ${r.end_date} ولم يُرصد نشاط بعدها.`, COLORS.warning)] });
    }
    db.prepare('UPDATE leave_requests SET reminders_sent = ? WHERE id = ?').run(r.reminders_sent + ',overdue', r.id);
  }
}

// ===== التقارير =====
async function dailyReport(client) {
  const d = reports.daily();
  reports.save('daily', today(), d);
  const e = embed(`📅 التقرير اليومي — ${today()}`, null, COLORS.info).addFields(
    { name: '👥 الإداريون', value: `${d.total}`, inline: true }, { name: '🟢 نشطون (24س)', value: `${d.active}`, inline: true }, { name: '🏖️ بإجازة', value: `${d.onLeave}`, inline: true },
    { name: '🎫 تكتات اليوم', value: `${d.tickets}`, inline: true }, { name: '🛡️ إجراءات اليوم', value: `${d.actions}`, inline: true }, { name: '🔴 غائبون (72س+)', value: d.absent.length ? d.absent.map(m => `<@${m.user_id}>`).join(' ') : 'لا يوجد', inline: false },
    { name: '⏳ طلبات معلّقة', value: `إجازات: ${d.pending.leaves} • استقالات: ${d.pending.resignations} • ترقيات: ${d.pending.promotions}` });
  await sendToChannel(client, 'performance-reports', { embeds: [e] });
}

async function weeklyReport(client) {
  // نقاط الأسبوع حسب Score
  for (const m of staffService.all()) {
    if (EXEMPT.includes(m.status)) continue;
    const sc = score.compute(m, score.monthlyRaw(m.user_id, 7)).score;
    if (sc >= 80) points.add(m.user_id, 'week_above_80', m.team, { refType: 'week', refId: today() });
    else if (sc < 50) points.add(m.user_id, 'week_below_50', m.team, { refType: 'week', refId: today() });
  }
  const embeds = [embed(`📆 التقرير الأسبوعي — ${today()}`, 'ترتيب الفرق والتقارير الفردية أدناه.', COLORS.primary)];
  for (const t of ['support', 'moderation']) {
    const lb = reports.leaderboard(t);
    reports.save('weekly', `${today()}:${t}`, lb.map(r => ({ user: r.staff.user_id, score: r.score, points: r.points })));
    embeds.push(reportCmds.leaderboardEmbed(lb, `🏆 ترتيب ${t === 'support' ? 'فريق الدعم الفني' : 'فريق الإشراف'} (أسبوعي)`));
  }
  await sendToChannel(client, 'performance-reports', { embeds });
  // تقرير فردي لكل إداري في الخاص
  for (const m of staffService.all()) {
    if (m.status === 'resigned') continue;
    await dm(client, m.user_id, { embeds: [reportCmds.performanceEmbed(reports.individual(m))] });
  }
  const idle = staffService.all().filter(m => !EXEMPT.includes(m.status) && hoursSince(m.last_activity || m.joined_at) >= ABSENCE.idleDays * 24);
  if (idle.length) await sendToChannel(client, 'staff-alerts', { embeds: [embed('💤 إداريون خاملون (7 أيام+)', idle.map(m => `<@${m.user_id}> — ${m.rank}`).join('\n'), COLORS.danger)] });
}

async function monthlyReport(client) {
  const period = today().slice(0, 7);
  const prevPeriod = addDays(today().slice(0, 7) + '-01', -1).slice(0, 7);
  const embeds = [];
  for (const t of ['support', 'moderation']) {
    const rows = reports.team(t);
    const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : 0;
    const prev = reports.lastSaved('monthly', `${prevPeriod}:${t}`);
    const diff = prev ? avg - prev.avg : null;
    reports.save('monthly', `${period}:${t}`, { avg, members: rows.map(r => ({ user: r.staff.user_id, score: r.score })) });
    const best = rows.filter(r => r.staff.rank !== 'Boss').sort((a, b) => b.score - a.score)[0];
    if (best) points.add(best.staff.user_id, 'best_of_month', t, { refType: 'month', refId: period });
    embeds.push(embed(`🗓️ التقرير الشهري — ${t === 'support' ? 'الدعم الفني' : 'الإشراف'} (${period})`,
      `متوسط Score: **${avg}**${diff != null ? ` (${diff >= 0 ? '📈 +' : '📉 '}${diff} عن الشهر الماضي)` : ''}\n🏅 أفضل إداري: ${best ? `<@${best.staff.user_id}> (${best.score})` : '—'}\n` +
      `🎫/🛡️ الإجمالي: ${rows.reduce((s, r) => s + (t === 'support' ? r.raw.tickets : r.raw.actions), 0)}\n⚠️ إنذارات: ${rows.reduce((s, r) => s + r.warnings.reduce((x, w) => x + w.c, 0), 0)}`, COLORS.primary));
  }
  const db = getDb();
  const res = db.prepare(`SELECT reason FROM resignations WHERE status = 'accepted' AND reviewed_at >= datetime('now', '-30 days')`).all();
  if (res.length) embeds.push(embed('📤 تحليل الاستقالات (30 يوم)', res.map((r, k) => `${k + 1}. ${r.reason.slice(0, 150)}`).join('\n'), COLORS.gray));
  await sendToChannel(client, 'performance-reports', { embeds });
}

function start(client) {
  const tz = process.env.TZ || 'Asia/Riyadh';
  cron.schedule('*/30 * * * *', () => checkAbsence(client).catch(console.error), { timezone: tz });
  cron.schedule('5 0 * * *', () => processLeaves(client).catch(console.error), { timezone: tz });
  cron.schedule('15 0 * * *', () => backup.createBackup({ reason: 'scheduled' }).catch(e => console.error('فشل النسخ الاحتياطي التلقائي:', e.message)), { timezone: tz });
  cron.schedule('0 9 * * *', () => dailyReport(client).catch(console.error), { timezone: tz });
  cron.schedule('0 10 * * 5', () => weeklyReport(client).catch(console.error), { timezone: tz });
  cron.schedule('0 11 1 * *', () => monthlyReport(client).catch(console.error), { timezone: tz });
  // تشغيل أولي
  setTimeout(() => { checkAbsence(client).catch(console.error); processLeaves(client).catch(console.error); }, 10_000);
  console.log('⏰ المجدول يعمل.');
}

module.exports = { start, checkAbsence, processLeaves, dailyReport, weeklyReport, monthlyReport };
