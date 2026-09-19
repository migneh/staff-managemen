'use strict';
const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { LEVELS, MOD_ACTION_TYPES } = require('../constants');
const { getDb } = require('../database');
const ticketLogs = require('../services/ticketLogs');
const audit = require('../services/audit');
const points = require('../services/points');
const { embed, COLORS, replyEphemeral, sendToChannel } = require('../utils');

const ID_RE = /^\d{15,22}$/;
const field = (id, label, opts = {}) => new ActionRowBuilder().addComponents(
  new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(opts.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(opts.required ?? true).setMaxLength(opts.max || 100).setPlaceholder(opts.ph || ''));

function ticketEmbed(result, loggedBy, sourceLabel = 'يدوي') {
  const row = result.row;
  return embed(`🎫 تكت مسجل ${result.reopened ? '♻️' : ''}`, null, result.reopened ? COLORS.warning : COLORS.success).addFields(
    { name: 'رقم التكت', value: `\`${row.ticketId}\``, inline: true },
    { name: 'صاحب التكت', value: `<@${row.owner}>`, inline: true },
    { name: 'المستلم', value: `<@${row.claimer}>`, inline: true },
    { name: 'أغلقه', value: `<@${row.closer || row.claimer}>`, inline: true },
    { name: 'التقييم', value: row.rating ? '⭐'.repeat(row.rating) : '—', inline: true },
    { name: 'المدة', value: row.duration != null ? `${row.duration} دقيقة` : '—', inline: true },
    { name: 'النقاط', value: `${result.earned >= 0 ? '+' : ''}${result.earned}`, inline: true },
    { name: 'المصدر', value: sourceLabel, inline: true },
    ...(row.ticketUrl ? [{ name: 'سجل التكت الخارجي', value: row.ticketUrl }] : []),
  ).setFooter({ text: `السجل #${row.id}${result.reopened ? ' • تكت معاد فتحه' : ''}` });
}

async function saveTicket(i, input, sourceLabel = 'يدوي') {
  const result = ticketLogs.recordTicket(input);
  if (result.duplicate) return replyEphemeral(i, result.manualDuplicate
    ? 'ℹ️ هذا الرقم مسجل مسبقاً، ولن تُضاف نقاط مكررة. إذا أُعيد فتح التكت فليُسجّل من سجل البوت الخارجي.'
    : 'ℹ️ هذا السجل الخارجي تم احتسابه مسبقاً، ولن تُضاف نقاط مكررة.', COLORS.info);
  audit.record({ action: 'ticket_logged', actorId: i.user.id, targetId: input.claimer, details: {
    ticketId: input.ticketId,
    source: input.source || 'manual',
    rowId: result.row.id,
    manualOverride: input.source === 'manual' && input.claimer !== i.user.id,
  }, channelId: i.channelId });
  const e = ticketEmbed(result, i.user.id, sourceLabel);
  await sendToChannel(i.client, 'ticket-logs', { embeds: [e] });
  return i.reply({ embeds: [e], ephemeral: true });
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('log-ticket').setDescription('تسجيل تكت مغلق يدوياً (بديل عند تعطل سجل البوت الخارجي)'),
      level: LEVELS.STAFF, team: 'support',
      async execute(i) {
        const m = new ModalBuilder().setCustomId('ticket:log').setTitle('🎫 تسجيل تكت يدوي');
        m.addComponents(
          field('ticket_id', 'رقم التكت', { max: 40 }),
          field('owner', 'ID صاحب التكت', { max: 22, ph: '123456789012345678' }),
          field('claimer', 'ID من استلم التكت', { max: 22, ph: 'اتركه = ID الخاص بك', required: false }),
          field('closer', 'ID من قفل التكت — اختياري', { max: 22, required: false }),
          field('rating', 'تقييم العميل (1-5) — اختياري', { max: 1, required: false }),
          field('duration', 'مدة الحل — اختياري (دقائق أو HH:MM)', { max: 10, required: false, ph: 'مثال: 45 أو 01:23' }),
        );
        return i.showModal(m);
      },
    },
    {
      data: new SlashCommandBuilder().setName('log-action').setDescription('تسجيل إجراء إشرافي (فريق الإشراف)')
        .addStringOption(o => o.setName('type').setDescription('نوع الإجراء').setRequired(true)
          .addChoices(...Object.entries(MOD_ACTION_TYPES).map(([v, n]) => ({ name: n, value: v })))),
      level: LEVELS.STAFF, team: 'moderation',
      async execute(i) {
        const type = i.options.getString('type');
        const m = new ModalBuilder().setCustomId(`modaction:log:${type}`).setTitle(`🛡️ تسجيل: ${MOD_ACTION_TYPES[type]}`);
        m.addComponents(
          field('target', 'ID العضو المستهدف', { max: 22 }),
          field('reason', 'السبب', { long: true, max: 500 }),
          field('duration', 'المدة (للتايم أوت) — اختياري', { max: 30, required: false, ph: 'مثال: 10 دقائق' }),
          field('evidence', 'رابط الدليل — اختياري', { max: 300, required: false }),
        );
        return i.showModal(m);
      },
    },
  ],

  components: {
    'ticket:log': async (i) => {
      const ticketId = i.fields.getTextInputValue('ticket_id').trim();
      const owner = i.fields.getTextInputValue('owner').trim();
      const claimer = (i.fields.getTextInputValue('claimer') || '').trim() || i.user.id;
      const closer = (i.fields.getTextInputValue('closer') || '').trim() || claimer;
      const ratingRaw = (i.fields.getTextInputValue('rating') || '').trim();
      const durRaw = (i.fields.getTextInputValue('duration') || '').trim();
      if (!ID_RE.test(owner) || !ID_RE.test(claimer) || !ID_RE.test(closer)) return replyEphemeral(i, '❌ معرفات الأعضاء غير صحيحة.', COLORS.danger);
      const rating = ratingRaw ? Number(ratingRaw) : null;
      if (rating != null && !(rating >= 1 && rating <= 5)) return replyEphemeral(i, '❌ التقييم يجب أن يكون بين 1 و 5.', COLORS.danger);
      if (claimer !== i.user.id && i.staffLevel < LEVELS.SUPERVISOR) {
        return replyEphemeral(i, '❌ لا يمكنك تسجيل تكت باسم إداري آخر. هذه الصلاحية متاحة للمشرفين فأعلى.', COLORS.danger);
      }
      const duration = durRaw ? ticketLogs.parseDuration(durRaw) : null;
      if (durRaw && !(duration >= 0)) return replyEphemeral(i, '❌ المدة غير صحيحة. اكتب دقائق مثل `45` أو ساعة:دقيقة مثل `01:23`.', COLORS.danger);
      return saveTicket(i, { ticketId, owner, claimer, closer, rating, duration, durationSource: duration == null ? null : 'reported', loggedBy: i.user.id, source: 'manual' });
    },

    'modaction:log': async (i, [type]) => {
      const target = i.fields.getTextInputValue('target').trim();
      const reason = i.fields.getTextInputValue('reason').trim();
      const duration = (i.fields.getTextInputValue('duration') || '').trim() || null;
      const evidence = (i.fields.getTextInputValue('evidence') || '').trim() || null;
      if (!ID_RE.test(target)) return replyEphemeral(i, '❌ معرف العضو غير صحيح.', COLORS.danger);
      if (!MOD_ACTION_TYPES[type]) return replyEphemeral(i, '❌ نوع الإجراء غير صحيح.', COLORS.danger);

      const res = getDb().prepare(`INSERT INTO mod_actions (moderator_id, target_id, action_type, reason, duration, evidence) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(i.user.id, target, type, reason, duration, evidence);
      const earned = points.add(i.user.id, 'mod_action', 'moderation', { refType: 'mod_action', refId: res.lastInsertRowid });
      audit.record({ action: 'moderation_action_logged', actorId: i.user.id, targetId: target, details: { type, reason, evidence, rowId: res.lastInsertRowid }, channelId: i.channelId });

      const e = embed(`🛡️ إجراء إشرافي: ${MOD_ACTION_TYPES[type]}`, null, COLORS.warning).addFields(
        { name: 'المشرف', value: `<@${i.user.id}>`, inline: true },
        { name: 'العضو', value: `<@${target}> (\`${target}\`)`, inline: true },
        { name: 'المدة', value: duration || '—', inline: true },
        { name: 'السبب', value: reason },
        ...(evidence ? [{ name: 'الدليل', value: evidence }] : []),
        { name: 'النقاط', value: `+${earned}`, inline: true },
      ).setFooter({ text: `السجل #${res.lastInsertRowid}` });
      await sendToChannel(i.client, 'mod-logs', { embeds: [e] });
      return i.reply({ embeds: [e], ephemeral: true });
    },
  },
};
