'use strict';
const cron = require('node-cron');
const { getDb } = require('./database');
const staffService = require('./services/staff');
const reports = require('./services/reports');
const points = require('./services/points');
const score = require('./services/score');
const { ABSENCE, LEAVE_GLOBAL } = require('./constants');
const settings = require('./services/settings');
const leaveService = require('./services/leaves');
const audit = require('./services/audit');
const { embed, COLORS, sendToChannel, dm, hoursSince, today, addDays, daysBetween } = require('./utils');
const reportCmds = require('./commands/reports');
const backup = require('./services/backup');
const kit = require('./ui/kit');

const EXEMPT = ['on_leave', 'suspended', 'resigned'];

// ===== فاحص الغياب — يتجمد أثناء الإجازة =====
async function checkAbsence(client) {
  for (const m of staffService.all()) {
    if (EXEMPT.includes(m.status)) continue;
    // المجاز لا يُحتسب غيابه
    if (leaveService.activeForUser(m.user_id).length) continue;
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

// ===== الإجازات: تفعيل الرتبة / إنهاء / تذكيرات / مزامنة / انتهاء المعلقة =====
async function guildMember(client, userId) {
  const guild = client.guilds?.cache?.get(settings.load()?.guildId || require('./config').guildId) || client.guilds?.cache?.get(require('./config').guildId) || client.guilds?.cache?.first?.();
  // fallback: ابحث في كل السيرفرات
  const g = guild || [...(client.guilds?.cache?.values?.() || [])][0];
  try { return g?.members?.fetch ? await g.members.fetch(userId) : null; } catch { return null; }
}

async function processLeaves(client) {
  const db = getDb();
  const t = today();
  const policy = settings.leavePolicy();

  // 0) إسقاط الطلبات المعلقة المنتهية (طلبه كان لماضٍ وانتهت مهلته)
  const expireDays = Number(policy.pendingExpireDays || LEAVE_GLOBAL.pendingExpireDays || 10);
  const pendingRows = db.prepare(`SELECT * FROM leave_requests WHERE status='pending'`).all();
  for (const r of pendingRows) {
    // إذا انتهت فترة الإجازة دون مراجعة، أو بقي معلقاً أكثر من expireDays
    const created = (r.created_at || '').slice(0, 10);
    const age = created ? daysBetween(created, t) : 0;
    if (r.end_date < t || age >= expireDays) {
      db.prepare(`UPDATE leave_requests SET status='cancelled', cancelled_at=datetime('now'), cancel_reason='انتهت دون مراجعة', end_reason='auto' WHERE id=?`).run(r.id);
      try {
        await updateLeaveMessage(client, r.id);
        await dm(client, r.user_id, { embeds: [embed('⌛ انتهى طلب إجازتك دون مراجعة', `طلبك **#${r.id}** (${r.start_date} → ${r.end_date}) انتهت مدته دون قرار.\nيمكنك تقديم طلب جديد إن احتجت.`, COLORS.gray)] });
      } catch {}
      audit.record({ action: 'leave_auto_expired', targetId: r.user_id, details: { requestId: r.id, reason: 'pending_expired' } });
    }
  }

  const rows = db.prepare(`SELECT * FROM leave_requests WHERE status = 'approved' ORDER BY start_date`).all();
  for (const r of rows) {
    const s = staffService.get(r.user_id);
    const member = await guildMember(client, r.user_id);

    // تذكير قبل البداية بيوم
    if (r.start_date === addDays(t, 1) && leaveService.markReminder(r.id, r.reminders_sent, 'start')) {
      await dm(client, r.user_id, { embeds: [embed('🏖️ تذكير بداية الإجازة', `إجازتك **#${r.id}** تبدأ غداً (${kit.tsDate(r.start_date)}).\n${policy.vacationRoleTiming === 'at_start' ? 'ستُفعّل رتبة **in vacation** تلقائياً.' : 'رتبة **in vacation** مفعّلة من الموافقة.'}`, COLORS.info)] });
    }

    // تفعيل الحالة والرتبة
    const timing = policy.vacationRoleTiming || 'at_start';
    if (r.start_date <= t && r.end_date >= t) {
      if (s && s.status !== 'on_leave' && s.status !== 'resigned') staffService.setStatus(r.user_id, 'on_leave');
      if (member) {
        // at_start: فعّل فقط عندما تبدأ. at_approval: كانت مفعلة من الموافقة
        const shouldAdd = timing === 'at_start' ? true : true;
        if (shouldAdd) {
          const roleResult = await staffService.addVacationRole(member);
          if (roleResult.ok && !r.role_applied_at) db.prepare("UPDATE leave_requests SET role_applied_at = datetime('now') WHERE id = ?").run(r.id);
          if (!roleResult.ok && leaveService.markReminder(r.id, r.reminders_sent, 'role_retry')) {
            await sendToChannel(client, 'staff-logs', { embeds: [embed('⚠️ تعذر تفعيل رتبة in vacation', `الإجازة **#${r.id}** لـ <@${r.user_id}> — ${roleResult.missing ? 'الرتبة غير مربوطة في /setup' : roleResult.error?.message || 'صلاحيات'}`, COLORS.warning)] });
          }
        }
      }
    }

    if (r.end_date === addDays(t, 1) && leaveService.markReminder(r.id, r.reminders_sent, 'end')) {
      await dm(client, r.user_id, { embeds: [embed('🏖️ تذكير نهاية الإجازة', `إجازتك تنتهي غداً (${kit.tsDate(r.end_date)}). نرجو العودة للنشاط بعدها.`, COLORS.info)] });
    }

    if (r.end_date < t) {
      const ended = db.prepare(`UPDATE leave_requests SET status = 'ended', end_reason = COALESCE(end_reason,'auto') WHERE id = ? AND status = 'approved'`).run(r.id);
      if (ended.changes) audit.record({ action: 'leave_ended', targetId: r.user_id, details: { requestId: r.id, reason: 'انتهاء المدة تلقائياً' } });
      const roleResult = member ? await leaveService.syncVacationRole(member, t) : null;
      if (roleResult?.ok && !leaveService.approvedForUser(r.user_id, { onOrAfter: t }).length) db.prepare("UPDATE leave_requests SET role_removed_at = COALESCE(role_removed_at, datetime('now')) WHERE id = ?").run(r.id);
      await updateLeaveMessage(client, r.id);
      const remaining = leaveService.activeForUser(r.user_id, t);
      if (s && s.status === 'on_leave' && !remaining.length) staffService.update(r.user_id, {
        status: 'active', absence_alert_level: 0, last_activity: new Date().toISOString().replace('T', ' ').slice(0, 19),
      });
    } else {
      // مزامنة الرسالة أيضاً للإجازات النشطة (حتى يظهر عدّاد التغطية المحدث)
    }
  }

  // إعادة محاولة إزالة الرتبة إن فشلت سابقاً
  const cleanupUsers = db.prepare(`SELECT DISTINCT user_id FROM leave_requests WHERE status IN ('ended', 'cancelled') AND role_removed_at IS NULL`).all();
  for (const { user_id: userId } of cleanupUsers) {
    const member = await guildMember(client, userId);
    if (!member) continue;
    const roleResult = await leaveService.syncVacationRole(member, t);
    if (roleResult.ok && !leaveService.approvedForUser(userId, { onOrAfter: t }).length) {
      db.prepare("UPDATE leave_requests SET role_removed_at = COALESCE(role_removed_at, datetime('now')) WHERE user_id = ? AND status IN ('ended', 'cancelled') AND role_removed_at IS NULL").run(userId);
    }
  }

  // تنبيه بعد النهاية بـ 24 ساعة إن لم يعد
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

async function updateLeaveMessage(client, id) {
  try {
    const r = getDb().prepare('SELECT * FROM leave_requests WHERE id=?').get(Number(id));
    if (!r?.message_id) return;
    const { getChannel } = require('./utils');
    const ch = await getChannel(client, 'leave-requests');
    if (!ch) return;
    const msg = await ch.messages.fetch(r.message_id);
    const { LEAVE_TYPES, LEAVE_RULES } = require('./constants');
    const rule = LEAVE_RULES[r.leave_type] || {};
    const color = { pending: COLORS.warning, approved: COLORS.success, rejected: COLORS.danger, ended: COLORS.gray, cancelled: COLORS.gray }[r.status] || COLORS.gray;
    const e = embed(`${rule.emoji || '🏖️'} إجازة #${r.id} — ${LEAVE_TYPES[r.leave_type] || r.leave_type}`, null, color)
      .addFields({ name: 'الحالة', value: ({ pending: '⏳ معلق', approved: '✅ معتمد', rejected: '❌ مرفوض', ended: '🏁 منتهي', cancelled: '🚫 ملغى' }[r.status] || r.status), inline: true });
    await msg.edit({ embeds: [e], components: [] });
  } catch {}
}

// ===== الاستقالات: تذكيرات + تصعيد + إزالة مؤجلة =====
async function processResignations(client) {
  const db = getDb();
  const t = today();
  const policy = settings.resignationPolicy();
  const rows = db.prepare(`SELECT * FROM resignations WHERE status IN ('pending', 'on_hold') ORDER BY last_day`).all();
  for (const r of rows) {
    const sent = new Set(String(r.reminders_sent || '').split(',').filter(Boolean));
    const notified = new Set(String(r.notified_reviewers || '').split(',').filter(Boolean));
    const mark = key => {
      if (sent.has(key)) return false;
      sent.add(key);
      db.prepare('UPDATE resignations SET reminders_sent = ? WHERE id = ?').run([...sent].join(','), r.id);
      return true;
    };
    const days = daysBetween(t, r.last_day);
    if (days <= 3 && days > 1 && mark('three_day')) {
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('📤 استقالة قريبة', `الاستقالة السرية **#${r.id}** لـ <@${r.user_id}> يصل آخر يوم لها بعد **3 أيام** (${kit.tsDate(r.last_day)}). يرجى مراجعتها.`, COLORS.warning)] });
      await dm(client, r.user_id, { embeds: [embed('📤 تذكير بالاستقالة', `طلب استقالتك **#${r.id}** ما زال قيد المراجعة، وآخر يوم هو **${kit.tsDate(r.last_day)}**.`, COLORS.warning)] });
    }
    if (days === 1 && mark('one_day')) {
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('🚨 استقالة غداً', `الاستقالة السرية **#${r.id}** لـ <@${r.user_id}> آخر يوم لها غداً (**${kit.tsDate(r.last_day)}**). يلزم قرار الإدارة.`, COLORS.danger)] });
      await dm(client, r.user_id, { embeds: [embed('🚨 آخر يوم قريب', `آخر يوم في طلب استقالتك **#${r.id}** هو غداً. سيصلك قرار الإدارة عبر الخاص.`, COLORS.warning)] });
    }
    if (days <= 0 && mark('overdue')) {
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('⚠️ استقالة تجاوزت آخر يوم', `الطلب السري **#${r.id}** لـ <@${r.user_id}> تجاوز آخر يوم **${kit.tsDate(r.last_day)}** دون قرار.`, COLORS.danger)] });
      await dm(client, r.user_id, { embeds: [embed('⚠️ متابعة الاستقالة', `انتهى التاريخ المحدد لطلب استقالتك **#${r.id}** وما زال القرار قيد المراجعة. تواصل مع الإدارة.`, COLORS.warning)] });
    }
    // تصعيد: إذا بقي معلقاً أكثر من pendingEscalateDays
    const created = (r.created_at || '').slice(0, 10);
    const age = created ? daysBetween(created, t) : 0;
    if (age >= (policy.pendingEscalateDays || 3) && !notified.has('escalated') && ['pending', 'on_hold'].includes(r.status)) {
      notified.add('escalated');
      db.prepare('UPDATE resignations SET notified_reviewers=? WHERE id=?').run([...notified].join(','), r.id);
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('⏰ تصعيد استقالة معلقة', `الطلب **#${r.id}** لـ <@${r.user_id}> معلق منذ **${age}** أيام — يلزم قرار سريع.`, COLORS.danger)] });
    }
  }

  // إزالة الرتب المؤجلة (remove_roles_at)
  const deferred = db.prepare("SELECT * FROM resignations WHERE status='accepted' AND remove_roles_at IS NOT NULL AND remove_roles_at <= ? AND roles_removed_at IS NULL").all(t);
  for (const r of deferred) {
    const member = await guildMember(client, r.user_id);
    if (!member) continue;
    const staffRolesRemoved = await staffService.removeAllStaffRoles(member);
    const vacationRoleRemoved = await staffService.removeVacationRole(member);
    if (staffRolesRemoved && vacationRoleRemoved.ok) {
      db.prepare("UPDATE resignations SET roles_removed_at = datetime('now') WHERE id = ?").run(r.id);
      audit.record({ action: 'resignation_roles_removed_deferred', targetId: r.user_id, details: { requestId: r.id } });
    }
  }
  // إعادة محاولة إزالة فورية إن فشلت
  const accepted = db.prepare("SELECT * FROM resignations WHERE status = 'accepted' AND roles_removed_at IS NULL AND (remove_roles_at IS NULL OR remove_roles_at <= ?)").all(t);
  for (const r of accepted) {
    if (deferred.some(d => d.id === r.id)) continue;
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
  const e = embed(`📅 التقرير اليومي — ${kit.tsDate(today())}`, null, COLORS.info).addFields(
    { name: '👥 الإداريون', value: `${d.total}`, inline: true }, { name: '🟢 نشطون (24س)', value: `${d.active}`, inline: true }, { name: '🏖️ بإجازة', value: `${d.onLeave}`, inline: true },
    { name: '🎫 تكتات اليوم', value: `${d.tickets}`, inline: true }, { name: '🛡️ إجراءات اليوم', value: `${d.actions}`, inline: true }, { name: '🔴 غائبون (72س+)', value: d.absent.length ? d.absent.map(m => `<@${m.user_id}>`).join(' ') : 'لا يوجد', inline: false },
    { name: '⏳ طلبات معلّقة', value: `إجازات: ${d.pending.leaves} • استقالات: ${d.pending.resignations} • ترقيات: ${d.pending.promotions}` });
  await sendToChannel(client, 'performance-reports', { embeds: [e] });
}

async function weeklyReport(client) {
  for (const m of staffService.all()) {
    if (EXEMPT.includes(m.status)) continue;
    if (leaveService.activeForUser(m.user_id).length) continue;
    const sc = score.compute(m, score.monthlyRaw(m.user_id, 7)).score;
    if (sc >= 80) points.add(m.user_id, 'week_above_80', m.team, { refType: 'week', refId: today() });
    else if (sc < 50) points.add(m.user_id, 'week_below_50', m.team, { refType: 'week', refId: today() });
  }
  const embeds = [embed(`📆 التقرير الأسبوعي — ${kit.tsDate(today())}`, 'ترتيب الفرق والتقارير الفردية أدناه.', COLORS.primary)];
  for (const t of ['support', 'moderation']) {
    const lb = reports.leaderboard(t);
    reports.save('weekly', `${today()}:${t}`, lb.map(r => ({ user: r.staff.user_id, score: r.score, points: r.points })));
    embeds.push(reportCmds.leaderboardEmbed(lb, `🏆 ترتيب ${t === 'support' ? 'فريق الدعم الفني' : 'فريق الإشراف'} (أسبوعي)`));
  }
  await sendToChannel(client, 'performance-reports', { embeds });
  for (const m of staffService.all()) {
    if (m.status === 'resigned') continue;
    await dm(client, m.user_id, { embeds: [reportCmds.performanceEmbed(reports.individual(m))] });
  }
  const idle = staffService.all().filter(m => !EXEMPT.includes(m.status) && !leaveService.activeForUser(m.user_id).length && hoursSince(m.last_activity || m.joined_at) >= ABSENCE.idleDays * 24);
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
  const res = db.prepare(`SELECT reason, reason_category FROM resignations WHERE status = 'accepted' AND reviewed_at >= datetime('now', '-30 days')`).all();
  if (res.length) {
    const byCat = {};
    for (const r of res) { const k = r.reason_category || 'other'; (byCat[k] ||= []).push(r.reason); }
    const lines = Object.entries(byCat).map(([k, arr]) => {
      const info = require('./constants').RESIGNATION_REASONS[k] || { label: k, emoji: '📝' };
      return `${info.emoji} **${info.label}**: ${arr.length}`;
    });
    embeds.push(embed('📤 تحليل الاستقالات (30 يوم)', lines.join('\n') + '\n\n' + res.slice(0, 3).map((r, k) => `${k + 1}. ${String(r.reason).slice(0, 120)}`).join('\n'), COLORS.gray));
  }
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
  setTimeout(() => { checkAbsence(client).catch(console.error); processLeaves(client).catch(console.error); processResignations(client).catch(console.error); }, 10_000);
  console.log('⏰ المجدول يعمل.');
}

module.exports = { start, checkAbsence, processLeaves, processResignations, dailyReport, weeklyReport, monthlyReport };
