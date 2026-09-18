'use strict';
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder } = require('discord.js');
const { LEVELS, TEAMS, STATUS, WARNING_TYPES } = require('../constants');
const reports = require('../services/reports');
const load = require('../services/load');
const points = require('../services/points');
const staffService = require('../services/staff');
const taskService = require('../services/tasks');
const audit = require('../services/audit');
const { getDb } = require('../database');
const { embed, COLORS, replyEphemeral, progressBar, scoreColor, scoreEmoji, divider, nowIso } = require('../utils');
const { LEADERBOARD_MIN_ACTIVE_DAYS } = require('../services/reports');

/** النافذة الموحّدة للترتيب — أسبوعان أعدل من 7 أيام في الفرق الصغيرة */
const LEADERBOARD_WINDOW_DAYS = 14;

function performanceEmbed(r) {
  const { staff, raw } = r;
  const e = embed(`📊 تقرير الأداء — ${staff.username || staff.user_id}`, `👤 <@${staff.user_id}> • **${staff.rank}** • ${TEAMS[staff.team]} • ${STATUS[staff.status]}\n${divider}`, scoreColor(r.score));
  e.addFields(
    { name: `${scoreEmoji(r.score)} Score ${r.score}/100 — ${r.grade}`, value: `${progressBar(r.score, 100, 20)}\n` + r.factors.map(f => `${progressBar(f.pts, f.max, 5)} **${f.name}** ${f.pts}/${f.max} · ${f.detail}`).join('\n') },
    ...(staff.team === 'support'
      ? [{ name: '🎫 التكتات', value: `${raw.tickets}`, inline: true }, { name: '⏱️ متوسط الحل', value: raw.avgDuration != null ? `${raw.avgDuration} د` : '—', inline: true }, { name: '⭐ التقييم', value: raw.avgRating != null ? `${raw.avgRating}` : '—', inline: true }]
      : [{ name: '🛡️ المخالفات المعالجة', value: `${raw.actions}`, inline: true }]),
    { name: '📅 أيام النشاط', value: `${raw.activeDays}/30`, inline: true },
    ...(raw.weightedMessages != null ? [{ name: '📡 وزن النشاط', value: `${raw.messages} رسالة → وزن ${Math.round(raw.weightedMessages)}`, inline: true }] : []),
    { name: '🚫 أيام الغياب', value: `${r.absentDays}`, inline: true },
    { name: '🏖️ أيام الإجازة', value: `${raw.leaveDays}`, inline: true },
    { name: '⚠️ الإنذارات', value: r.warnings.length ? r.warnings.map(w => `${WARNING_TYPES[w.warning_type]?.label}: ${w.c}`).join(' • ') : 'لا يوجد', inline: true },
    ...(r.assessedMax != null && r.assessedMax < 100 ? [{ name: '🧮 كيف حُسب Score', value: `المقياس يُحتسب على **${r.assessedMax}** نقطة فقط (تُستثنى العوامل غير المُقيَّمة) ثم يُوحَّد إلى 100 — فلا تُمنح نقاط مقابل شيء لم يُقيَّم.` }] : []),
    { name: '📝 الملاحظات', value: `🟢 ${raw.positiveNotes} • 🟡 ${raw.negativeNotes}`, inline: true },
    { name: '🎯 نقاط الترقية', value: `${r.points}`, inline: true },
  );
  if (staff.status === 'on_leave') e.setFooter({ text: 'معذور — بإجازة معتمدة (Score مجمّد)' });
  return e;
}

function leaderboardEmbed(rows, title, days = LEADERBOARD_WINDOW_DAYS) {
  const unranked = rows.unranked || [];
  if (!rows.length && !unranked.length) return embed(title, 'لا يوجد إداريون مؤهلون للترتيب.', COLORS.gray);
  const medals = ['🥇', '🥈', '🥉'];
  const body = rows.length
    ? rows.slice(0, 20).map((r, idx) => `${medals[idx] || `\`${String(idx + 1).padStart(2, ' ')}\``} ${scoreEmoji(r.score)} **${r.score}** ${progressBar(r.score, 100, 8)} <@${r.staff.user_id}>\n╰ ${r.staff.rank} • ${r.staff.team === 'support' ? `🎫 ${r.raw.tickets}` : `🛡️ ${r.raw.actions}`} • 🎯 ${r.points}`).join('\n')
    : '_لا أحد بلغ الحد الأدنى للمشاركة._';
  const footer = `النافذة: آخر ${days} يوم • بلا حد أدنى للمشاركة: ${unranked.length} • Boss والمجازون مستبعدون`;
  return embed(title, body, COLORS.primary)
    .addFields(unranked.length ? [{
      name: `— بلا تصنيف (${unranked.length}) — أقل من ${LEADERBOARD_MIN_ACTIVE_DAYS} أيام نشاط و0 عنصر عمل`,
      value: unranked.slice(0, 8).map(r => `• <@${r.staff.user_id}> — ${r.staff.rank} • ${r.raw.activeDays} يوم نشاط`).join('\n') + (unranked.length > 8 ? `\n_… و${unranked.length - 8} آخرين_` : ''),
    }] : [])
    .setFooter({ text: footer });
}

function teamEmbed(teamKey, rows) {
  const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : 0;
  const e = embed(`👥 تقرير ${TEAMS[teamKey]}`, `الأعضاء: **${rows.length}** • متوسط Score: **${avg}**\n` +
    `🟢 ممتاز: ${rows.filter(r => r.grade === 'ممتاز').length} • 🔵 جيد: ${rows.filter(r => r.grade === 'جيد').length} • 🟡 يحتاج تحسين: ${rows.filter(r => r.grade === 'يحتاج تحسين').length} • 🔴 ضعيف: ${rows.filter(r => r.grade === 'ضعيف').length}`, COLORS.info);
  const lines = rows.sort((a, b) => b.score - a.score).map(r => `<@${r.staff.user_id}> • ${r.staff.rank} • **${r.score}** • ${STATUS[r.staff.status]}${r.lastActivityHours > 72 && r.staff.status !== 'on_leave' ? ' ⚠️' : ''}`);
  for (let k = 0; k < lines.length; k += 15) e.addFields({ name: k === 0 ? 'الأعضاء' : '\u200b', value: lines.slice(k, k + 15).join('\n') });
  return e;
}

function pointsCsv(rows) {
  const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const header = ['id', 'created_at', 'points', 'reason', 'reason_key', 'rank_epoch', 'counts_in_current_rank', 'reference', 'added_by'];
  const lines = rows.map(r => [r.id, r.created_at, r.points, r.reason, r.reason_key, r.rank_epoch, r.counts, r.ref_type && r.ref_id ? `${r.ref_type}:${r.ref_id}` : '', r.added_by].map(cell).join(','));
  return `\ufeff${header.map(cell).join(',')}\n${lines.join('\n')}\n`;
}

function pointsHistoryEmbed(userId, rows) {
  const lines = rows.map(r => `${r.points >= 0 ? '🟢 +' : '🔴 '}${r.points} • **${r.reason || r.reason_key}** • ${r.counts ? 'العصر الحالي' : 'عصر سابق'} • <t:${Math.floor(new Date(r.created_at.replace(' ', 'T') + 'Z').getTime() / 1000)}:d>`);
  const e = embed(`🧾 تاريخ النقاط — <@${userId}>`, lines.length ? lines.join('\n').slice(0, 4000) : 'لا توجد حركات نقاط مسجلة بعد.', COLORS.info)
    .setFooter({ text: 'النقاط موثقة بالسبب والمرجع والعصر. يمكنك الاعتراض على أي حركة حديثة.' });
  const buttons = rows.slice(0, 5).map(r => new ButtonBuilder().setCustomId(`points:contest:${r.id}`).setLabel(`اعتراض #${r.id}`).setEmoji('⚖️').setStyle(ButtonStyle.Secondary));
  const components = [];
  for (let i = 0; i < buttons.length; i += 5) components.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  return { embeds: [e], components };
}

function loadEmbed(team, rows, days) {
  const summary = load.fairness(rows);
  const lines = rows.length ? rows.map(r => {
    const count = r.work.closed ?? r.work.actions ?? 0;
    const detail = r.staff.team === 'support'
      ? `${count} تكت مغلق • متوسط ${r.work.avgDuration ?? '—'} د • ${r.work.avgRating ?? '—'} ⭐`
      : `${count} إجراء • ${r.work.activeDays} أيام عمل`;
    return `<@${r.staff.user_id}> — **${count}** • ${detail}`;
  }) : ['لا يوجد أعضاء مؤهلون في الفريق.'];
  const warning = summary.imbalance >= 2 ? `\n⚠️ أعلى حمل يساوي ${summary.imbalance}× متوسط الفريق.` : '';
  return embed(`⚖️ توزيع الحمل — ${TEAMS[team]} (آخر ${days} يوم)`, `${lines.join('\n')}${warning}`,
    summary.imbalance >= 2 ? COLORS.warning : COLORS.info)
    .addFields({ name: '📊 الملخص', value: `إجمالي العمل المسجل: **${summary.total}** • المتوسط: **${summary.average}**\n${summary.idle.length ? `خامل بلا عمل: ${summary.idle.map(id => `<@${id}>`).join(' ')}` : 'لا يوجد عضو بلا عمل مسجل'}` })
    .setFooter({ text: 'المؤشر مبني على العمل المسجل في قاعدة البيانات؛ التكتات المفتوحة تحتاج مصدراً منفصلاً.' });
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('my-performance').setDescription('عرض تقرير أدائك الشخصي'),
      level: LEVELS.STAFF,
      async execute(i) {
        const s = staffService.get(i.user.id);
        if (!s) return replyEphemeral(i, '❌ غير مسجل كإداري.', COLORS.danger);
        return i.reply({ embeds: [performanceEmbed(reports.individual(s))], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('staff-report').setDescription('عرض تقرير أداء إداري معين')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true)),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        const s = staffService.get(i.options.getUser('user').id);
        if (!s) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        return i.reply({ embeds: [performanceEmbed(reports.individual(s))], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('team-report').setDescription('تقرير الفريق')
        .addStringOption(o => o.setName('team').setDescription('الفريق').addChoices({ name: 'فريق الدعم الفني', value: 'support' }, { name: 'فريق الإشراف', value: 'moderation' })),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        await i.deferReply({ ephemeral: true });
        const team = i.options.getString('team');
        const teams = team ? [team] : ['support', 'moderation'];
        return i.editReply({ embeds: teams.map(t => teamEmbed(t, reports.team(t))) });
      },
    },
    {
      data: new SlashCommandBuilder().setName('leaderboard').setDescription('ترتيب الإداريين (للإدارة فقط)')
        .addStringOption(o => o.setName('team').setDescription('الفريق').addChoices({ name: 'فريق الدعم الفني', value: 'support' }, { name: 'فريق الإشراف', value: 'moderation' }, { name: 'عام', value: 'all' })),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        await i.deferReply({ ephemeral: true });
        const team = i.options.getString('team') || 'all';
        if (team === 'all') return i.editReply({ embeds: [leaderboardEmbed(reports.leaderboard('support', LEADERBOARD_WINDOW_DAYS), '🏆 ترتيب فريق الدعم الفني'), leaderboardEmbed(reports.leaderboard('moderation', LEADERBOARD_WINDOW_DAYS), '🏆 ترتيب فريق الإشراف')] });
        return i.editReply({ embeds: [leaderboardEmbed(reports.leaderboard(team, LEADERBOARD_WINDOW_DAYS), `🏆 ترتيب ${TEAMS[team]}`)] });
      },
    },
    {
      data: new SlashCommandBuilder().setName('points-history').setDescription('عرض تاريخ نقاطك مع تصدير CSV واعتراض موثق')
        .addIntegerOption(o => o.setName('limit').setDescription('عدد الحركات (1-50)').setMinValue(1).setMaxValue(50).setRequired(false))
        .addBooleanOption(o => o.setName('export').setDescription('تحميل السجل بصيغة CSV').setRequired(false)),
      level: LEVELS.STAFF,
      async execute(i) {
        const limit = i.options.getInteger('limit') || 15;
        const rows = points.history(i.user.id, limit);
        if (i.options.getBoolean('export')) {
          const file = new AttachmentBuilder(Buffer.from(pointsCsv(rows), 'utf8'), { name: `points-${i.user.id}.csv` });
          return i.reply({ content: `🧾 سجل نقاطك — ${rows.length} حركة.`, files: [file], ephemeral: true });
        }
        return i.reply({ ...pointsHistoryEmbed(i.user.id, rows), ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('point-appeals').setDescription('عرض اعتراضات النقاط المفتوحة')
        .addStringOption(o => o.setName('status').setDescription('الحالة').addChoices({ name: 'مفتوحة', value: 'pending' }, { name: 'كل الحالات', value: 'all' })),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const rows = taskService.listByType('points_appeal', { includeCompleted: i.options.getString('status') === 'all' });
        if (!rows.length) return replyEphemeral(i, '✅ لا توجد اعتراضات نقاط مفتوحة.', COLORS.success);
        const body = rows.slice(0, 15).map(t => `• **#${t.id}** <@${t.user_id}> — ${t.title}${t.description ? `\n  ${t.description}` : ''}`).join('\n').slice(0, 3500);
        return replyEphemeral(i, `⚖️ اعتراضات النقاط (${rows.length})\n${body}`, COLORS.warning);
      },
    },
    {
      data: new SlashCommandBuilder().setName('team-load').setDescription('توزيع العمل المسجل ومؤشر العدالة للفريق')
        .addStringOption(o => o.setName('team').setDescription('الفريق').addChoices({ name: 'الدعم الفني', value: 'support' }, { name: 'الإشراف', value: 'moderation' }))
        .addIntegerOption(o => o.setName('days').setDescription('النافذة بالأيام (1-90)').setMinValue(1).setMaxValue(90)),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        await i.deferReply({ ephemeral: true });
        const team = i.options.getString('team') || i.staffInfo?.team;
        if (!['support', 'moderation'].includes(team)) return i.editReply({ embeds: [embed('⚖️ توزيع الحمل', 'اختر فريقاً صالحاً.', COLORS.danger)] });
        const days = i.options.getInteger('days') || 7;
        return i.editReply({ embeds: [loadEmbed(team, load.teamLoad(team, days), days)] });
      },
    },
    {
      data: new SlashCommandBuilder().setName('rate-staff').setDescription('تقييم يدوي لإداري (يدخل في حساب Score)')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('factor').setDescription('العامل').setRequired(true).addChoices(
          { name: 'تقييم المشرف (Helper)', value: 'supervisor_rating' }, { name: 'التفاعل مع الفريق (Helper)', value: 'team_interaction' }, { name: 'سرعة الاستجابة (الإشراف)', value: 'response_speed' }))
        .addStringOption(o => o.setName('grade').setDescription('التقدير').setRequired(true).addChoices(
          { name: 'ممتاز (25)', value: '25' }, { name: 'جيد جداً (20)', value: '20' }, { name: 'جيد (15)', value: '15' }, { name: 'مقبول (10)', value: '10' }, { name: 'ضعيف (5)', value: '5' })),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        const user = i.options.getUser('user');
        const s = staffService.get(user.id);
        if (!s) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        const factor = i.options.getString('factor');
        staffService.update(user.id, { [factor]: Number(i.options.getString('grade')), human_ratings_at: nowIso() });
        return replyEphemeral(i, `✅ تم تحديث التقييم لـ <@${user.id}>.`, COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('award-points').setDescription('منح/خصم نقاط ترقية يدوياً')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('السبب').setRequired(true).addChoices(
          { name: 'مساعدة عضو جديد (+15)', value: 'helped_newbie' }, { name: 'حل تكت/حالة معقدة (+10)', value: 'complex_case' }, { name: 'استجابة سريعة (+5 إشراف)', value: 'fast_response' },
          { name: 'أفضل إداري بالشهر (+50)', value: 'best_of_month' }, { name: 'قرار خاطئ (-15 إشراف)', value: 'wrong_decision' }, { name: 'غياب بدون إجازة (-15)', value: 'absence' }, { name: 'سبام (-10)', value: 'spam' })),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        const user = i.options.getUser('user');
        const s = staffService.get(user.id);
        if (!s) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        const key = i.options.getString('reason');
        const pts = require('../services/points').add(user.id, key, s.team, { addedBy: i.user.id });
        if (!pts) return replyEphemeral(i, '❌ هذا السبب لا ينطبق على فريق هذا العضو.', COLORS.danger);
        await require('../utils').log(i.client, '🎯 نقاط يدوية', `<@${user.id}>: ${pts > 0 ? '+' : ''}${pts} بواسطة <@${i.user.id}>`, COLORS.gray);
        return replyEphemeral(i, `✅ ${pts > 0 ? '+' : ''}${pts} نقطة لـ <@${user.id}>.`, COLORS.success);
      },
    },
  ],
  components: {
    'points:contest': async (i, [id]) => {
      const point = getDb().prepare('SELECT * FROM promotion_points WHERE id = ? AND user_id = ?').get(Number(id), i.user.id);
      if (!point) return replyEphemeral(i, '❌ حركة النقاط غير موجودة أو ليست ضمن سجلك.', COLORS.danger);
      const modal = new ModalBuilder().setCustomId(`points:contestmodal:${point.id}`).setTitle(`⚖️ اعتراض على النقطة #${point.id}`);
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('اشرح سبب الاعتراض').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true)));
      return i.showModal(modal);
    },
    'points:contestmodal': async (i, [id]) => {
      const point = getDb().prepare('SELECT * FROM promotion_points WHERE id = ? AND user_id = ?').get(Number(id), i.user.id);
      if (!point) return replyEphemeral(i, '❌ حركة النقاط غير موجودة أو ليست ضمن سجلك.', COLORS.danger);
      const reason = i.fields.getTextInputValue('reason').trim();
      const title = `اعتراض على حركة النقاط #${point.id}`;
      const existing = getDb().prepare("SELECT id FROM staff_tasks WHERE user_id = ? AND task_type = 'points_appeal' AND status = 'pending' AND title = ?").get(i.user.id, title);
      if (existing) return replyEphemeral(i, `ℹ️ لديك اعتراض مفتوح مسبقاً (#${existing.id}) لهذه الحركة.`, COLORS.info);
      const task = taskService.create({
        userId: i.user.id,
        title,
        description: `النقاط: ${point.points} • السبب: ${point.reason || point.reason_key} • المرجع: ${point.ref_type || '—'}:${point.ref_id || '—'}\nمبرر الإداري: ${reason}`,
        taskType: 'points_appeal',
        assignedBy: i.user.id,
      });
      audit.record({ action: 'points_contested', actorId: i.user.id, targetId: i.user.id, details: { pointId: point.id, taskId: task.id, reason }, channelId: i.channelId });
      return replyEphemeral(i, `✅ تم فتح اعتراضك **#${task.id}** للإدارة. لن تتغير النقاط قبل المراجعة البشرية.`, COLORS.success);
    },
  },
  performanceEmbed, leaderboardEmbed, teamEmbed,
};
