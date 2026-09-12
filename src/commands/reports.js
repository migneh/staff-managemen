'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS, TEAMS, STATUS, WARNING_TYPES } = require('../constants');
const reports = require('../services/reports');
const staffService = require('../services/staff');
const { embed, COLORS, replyEphemeral, progressBar } = require('../utils');

function performanceEmbed(r) {
  const { staff, raw } = r;
  const e = embed(`📊 تقرير الأداء — ${staff.username || staff.user_id}`, `👤 <@${staff.user_id}> • **${staff.rank}** • ${TEAMS[staff.team]} • ${STATUS[staff.status]}`,
    r.score >= 70 ? COLORS.success : r.score >= 50 ? COLORS.warning : COLORS.danger);
  e.addFields(
    { name: `📈 Score: ${r.score}/100 — ${r.grade}`, value: `${progressBar(r.score, 100, 20)}\n` + r.factors.map(f => `• ${f.name}: **${f.pts}/${f.max}** (${f.detail})`).join('\n') },
    ...(staff.team === 'support'
      ? [{ name: '🎫 التكتات', value: `${raw.tickets}`, inline: true }, { name: '⏱️ متوسط الحل', value: raw.avgDuration != null ? `${raw.avgDuration} د` : '—', inline: true }, { name: '⭐ التقييم', value: raw.avgRating != null ? `${raw.avgRating}` : '—', inline: true }]
      : [{ name: '🛡️ المخالفات المعالجة', value: `${raw.actions}`, inline: true }]),
    { name: '📅 أيام النشاط', value: `${raw.activeDays}/30`, inline: true },
    { name: '🚫 أيام الغياب', value: `${r.absentDays}`, inline: true },
    { name: '🏖️ أيام الإجازة', value: `${raw.leaveDays}`, inline: true },
    { name: '⚠️ الإنذارات', value: r.warnings.length ? r.warnings.map(w => `${WARNING_TYPES[w.warning_type]?.label}: ${w.c}`).join(' • ') : 'لا يوجد', inline: true },
    { name: '📝 الملاحظات', value: `🟢 ${raw.positiveNotes} • 🟡 ${raw.negativeNotes}`, inline: true },
    { name: '🎯 نقاط الترقية', value: `${r.points}`, inline: true },
  );
  if (staff.status === 'on_leave') e.setFooter({ text: 'معذور — بإجازة معتمدة (Score مجمّد)' });
  return e;
}

function leaderboardEmbed(rows, title) {
  if (!rows.length) return embed(title, 'لا يوجد إداريون مؤهلون للترتيب.', COLORS.gray);
  const medals = ['🥇', '🥈', '🥉'];
  return embed(title, rows.slice(0, 20).map((r, idx) => `${medals[idx] || `**${idx + 1}.**`} <@${r.staff.user_id}> — **${r.score}** • ${r.staff.rank} • ${r.staff.team === 'support' ? `🎫 ${r.raw.tickets}` : `🛡️ ${r.raw.actions}`} • 🎯 ${r.points}`).join('\n'), COLORS.primary)
    .setFooter({ text: 'Boss والمجازون مستبعدون • آخر 30 يوم • للإدارة فقط' });
}

function teamEmbed(teamKey, rows) {
  const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : 0;
  const e = embed(`👥 تقرير ${TEAMS[teamKey]}`, `الأعضاء: **${rows.length}** • متوسط Score: **${avg}**\n` +
    `🟢 ممتاز: ${rows.filter(r => r.grade === 'ممتاز').length} • 🔵 جيد: ${rows.filter(r => r.grade === 'جيد').length} • 🟡 يحتاج تحسين: ${rows.filter(r => r.grade === 'يحتاج تحسين').length} • 🔴 ضعيف: ${rows.filter(r => r.grade === 'ضعيف').length}`, COLORS.info);
  const lines = rows.sort((a, b) => b.score - a.score).map(r => `<@${r.staff.user_id}> • ${r.staff.rank} • **${r.score}** • ${STATUS[r.staff.status]}${r.lastActivityHours > 72 && r.staff.status !== 'on_leave' ? ' ⚠️' : ''}`);
  for (let k = 0; k < lines.length; k += 15) e.addFields({ name: k === 0 ? 'الأعضاء' : '\u200b', value: lines.slice(k, k + 15).join('\n') });
  return e;
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
        if (team === 'all') return i.editReply({ embeds: [leaderboardEmbed(reports.leaderboard('support'), '🏆 ترتيب فريق الدعم الفني'), leaderboardEmbed(reports.leaderboard('moderation'), '🏆 ترتيب فريق الإشراف')] });
        return i.editReply({ embeds: [leaderboardEmbed(reports.leaderboard(team), `🏆 ترتيب ${TEAMS[team]}`)] });
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
        staffService.update(user.id, { [factor]: Number(i.options.getString('grade')) });
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
  components: {},
  performanceEmbed, leaderboardEmbed, teamEmbed,
};
