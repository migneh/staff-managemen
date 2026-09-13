'use strict';
const cron = require('node-cron');
const { getDb } = require('./database');
const staffService = require('./services/staff');
const reports = require('./services/reports');
const points = require('./services/points');
const score = require('./services/score');
const { ABSENCE } = require('./constants');
const config = require('./config');
const leaveService = require('./services/leaves');
const audit = require('./services/audit');
const { embed, COLORS, sendToChannel, dm, hoursSince, today, addDays, daysBetween } = require('./utils');
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

// ===== الإجازات: تفعيل الرتبة / إنهاء / تذكيرات / مزامنة =====
async function guildMember(client, userId) {
  const guild = client.guilds?.cache?.get(config.guildId) || client.guilds?.cache?.first?.();
  try { return guild?.members?.fetch ? await guild.members.fetch(userId) : null; } catch { return null; }
}

async function processLeaves(client) {
  const db = getDb();
  const t = today();
  const rows = db.prepare(`SELECT * FROM leave_requests WHERE status = 'approved' ORDER BY start_date`).all();
  for (const r of rows) {
    const s = staffService.get(r.user_id);
    const member = await guildMember(client, r.user_id);
    if (r.start_date === addDays(t, 1) && leaveService.markReminder(r.id, r.reminders_sent, 'start')) {
      await dm(client, r.user_id, { embeds: [embed('🏖️ تذكير بداية الإجازة', `إجازتك تبدأ غداً (${r.start_date}). تم تجهيز رتبة **in vacation**.`, COLORS.info)] });
    }

    if (r.start_date <= t && r.end_date >= t) {
      if (s && s.status !== 'on_leave' && s.status !== 'resigned') staffService.setStatus(r.user_id, 'on_leave');
      if (member) {
        const roleResult = await staffService.addVacationRole(member);
        if (roleResult.ok && !r.role_applied_at) db.prepare("UPDATE leave_requests SET role_applied_at = datetime('now') WHERE id = ?").run(r.id);
      }
    }

    if (r.end_date === addDays(t, 1) && leaveService.markReminder(r.id, r.reminders_sent, 'end')) {
      await dm(client, r.user_id, { embeds: [embed('🏖️ تذكير نهاية الإجازة', `إجازتك تنتهي غداً (${r.end_date}). نرجو العودة للنشاط.`, COLORS.info)] });
    }

    if (r.end_date < t) {
      const ended = db.prepare(`UPDATE leave_requests SET status = 'ended' WHERE id = ? AND status = 'approved'`).run(r.id);
      if (ended.changes) audit.record({ action: 'leave_ended', targetId: r.user_id, details: { requestId: r.id, reason: 'انتهاء المدة تلقائياً' } });
      const roleResult = member ? await leaveService.syncVacationRole(member, t) : null;
      if (roleResult?.ok && !leaveService.approvedForUser(r.user_id, { onOrAfter: t }).length) db.prepare("UPDATE leave_requests SET role_removed_at = COALESCE(role_removed_at, datetime('now')) WHERE id = ?").run(r.id);
      const remaining = leaveService.activeForUser(r.user_id, t);
      if (s && s.status === 'on_leave' && !remaining.length) staffService.update(r.user_id, {
        status: 'active', absence_alert_level: 0, last_activity: new Date().toISOString().replace('T', ' ').slice(0, 19),
      });
    }
  }

  // إذا كان العضو غير متاحاً أو فشلت صلاحية Discord، نعيد محاولة إزالة الرتبة في كل دورة.
  const cleanupUsers = db.prepare(`SELECT DISTINCT user_id FROM leave_requests
    WHERE status IN ('ended', 'cancelled') AND role_removed_at IS NULL`).all();
  for (const { user_id: userId } of cleanupUsers) {
    const member = await guildMember(client, userId);
    if (!member) continue;
    const roleResult = await leaveService.syncVacationRole(member, t);
    if (roleResult.ok && !leaveService.approvedForUser(userId, { onOrAfter: t }).length) {
      db.prepare("UPDATE leave_requests SET role_removed_at = COALESCE(role_removed_at, datetime('now')) WHERE user_id = ? AND status IN ('ended', 'cancelled') AND role_removed_at IS NULL").run(userId);
    }
  }

  // تنبيه بعد النهاية بـ 24 ساعة إن لم يعد الإداري، مع عدم تكراره.
  const ended = db.prepare(`SELECT * FROM leave_requests WHERE status = 'ended' AND end_date = ?`).all(addDays(t, -1));
  for (const r of ended) {
    if (!leaveService.markReminder(r.id, r.reminders_sent, 'overdue')) continue;
    const s = staffService.get(r.user_id);
    const activityAfter = db.prepare('SELECT 1 FROM activity_logs WHERE user_id = ? AND day > ? LIMIT 1').get(r.user_id, r.end_date);
    if (s && !activityAfter) {
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('⚠️ لم يعد من الإجازة', `<@${r.user_id}> انتهت إجازته في ${r.end_date} ولم يُرصد نشاط بعدها.`, COLORS.warning)] });
      await dm(client, r.user_id, { embeds: [embed('⚠️ تذكير العودة', `انتهت إجازتك في ${r.end_date}. نرجو العودة للنشاط أو التواصل مع الإدارة.`, COLORS.warning)] });
    }
  }
}

// ===== الاستقالات: تذكيرات سرية ومتابعة آخر يوم =====
async function processResignations(client) {
  const db = getDb();
  const t = today();
  const rows = db.prepare(`SELECT * FROM resignations WHERE status IN ('pending', 'on_hold') ORDER BY last_day`).all();
  for (const r of rows) {
    const sent = new Set(String(r.reminders_sent || '').split(',').filter(Boolean));
    const mark = key => {
      if (sent.has(key)) return false;
      sent.add(key);
      db.prepare('UPDATE resignations SET reminders_sent = ? WHERE id = ?').run([...sent].join(','), r.id);
      return true;
    };
    const days = daysBetween(t, r.last_day);
    if (days <= 3 && days > 1 && mark('three_day')) {
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('📤 استقالة قريبة', `الاستقالة السرية **#${r.id}** لـ <@${r.user_id}> يصل آخر يوم لها بعد **3 أيام**. يرجى مراجعتها.`, COLORS.warning)] });
      await dm(client, r.user_id, { embeds: [embed('📤 تذكير بالاستقالة', `طلب استقالتك **#${r.id}** ما زال قيد المراجعة، وآخر يوم هو **${r.last_day}**.`, COLORS.warning)] });
    }
    if (days === 1 && mark('one_day')) {
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('🚨 استقالة غداً', `الاستقالة السرية **#${r.id}** لـ <@${r.user_id}> آخر يوم لها غداً (**${r.last_day}**). يلزم قرار الإدارة.`, COLORS.danger)] });
      await dm(client, r.user_id, { embeds: [embed('🚨 آخر يوم قريب', `آخر يوم في طلب استقالتك **#${r.id}** هو غداً. سيصلك قرار الإدارة عبر الخاص.`, COLORS.warning)] });
    }
    if (days <= 0 && mark('overdue')) {
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('⚠️ استقالة تجاوزت آخر يوم', `الطلب السري **#${r.id}** لـ <@${r.user_id}> تجاوز آخر يوم **${r.last_day}** دون قرار.`, COLORS.danger)] });
      await dm(client, r.user_id, { embeds: [embed('⚠️ متابعة الاستقالة', `انتهى التاريخ المحدد لطلب استقالتك **#${r.id}** وما زال القرار قيد المراجعة. تواصل مع الإدارة.`, COLORS.warning)] });
    }
  }

  // إعادة محاولة إزالة الرتب إذا كان العضو غير متاحاً أو حدث خطأ في صلاحيات Discord عند القبول.
  const accepted = db.prepare("SELECT * FROM resignations WHERE status = 'accepted' AND roles_removed_at IS NULL").all();
  for (const r of accepted) {
    const member = await guildMember(client, r.user_id);
    if (!member) continue;
    const staffRolesRemoved = await staffService.removeAllStaffRoles(member);
    const vacationRoleRemoved = await staffService.removeVacationRole(member);
    if (staffRolesRemoved && vacationRoleRemoved.ok) db.prepare("UPDATE resignations SET roles_removed_at = datetime('now') WHERE id = ?").run(r.id);
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
  cron.schedule('20 0 * * *', () => processResignations(client).catch(console.error), { timezone: tz });
  cron.schedule('15 0 * * *', () => backup.createBackup({ reason: 'scheduled' }).catch(e => console.error('فشل النسخ الاحتياطي التلقائي:', e.message)), { timezone: tz });
  cron.schedule('0 9 * * *', () => dailyReport(client).catch(console.error), { timezone: tz });
  cron.schedule('0 10 * * 5', () => weeklyReport(client).catch(console.error), { timezone: tz });
  cron.schedule('0 11 1 * *', () => monthlyReport(client).catch(console.error), { timezone: tz });
  // تشغيل أولي
  setTimeout(() => { checkAbsence(client).catch(console.error); processLeaves(client).catch(console.error); processResignations(client).catch(console.error); }, 10_000);
  console.log('⏰ المجدول يعمل.');
}

module.exports = { start, checkAbsence, processLeaves, processResignations, dailyReport, weeklyReport, monthlyReport };
