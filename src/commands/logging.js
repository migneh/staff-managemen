'use strict';
const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { LEVELS, MOD_ACTION_TYPES } = require('../constants');
const { getDb } = require('../database');
const points = require('../services/points');
const staffService = require('../services/staff');
const { embed, COLORS, replyEphemeral, sendToChannel } = require('../utils');

const ID_RE = /^\d{15,22}$/;
const field = (id, label, opts = {}) => new ActionRowBuilder().addComponents(
  new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(opts.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(opts.required ?? true).setMaxLength(opts.max || 100).setPlaceholder(opts.ph || ''));

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('log-ticket').setDescription('تسجيل تكت مغلق (فريق الدعم الفني)'),
      level: LEVELS.STAFF, team: 'support',
      async execute(i) {
        const m = new ModalBuilder().setCustomId('ticket:log').setTitle('🎫 تسجيل تكت');
        m.addComponents(
          field('ticket_id', 'رقم التكت', { max: 40 }),
          field('owner', 'ID صاحب التكت', { max: 22, ph: '123456789012345678' }),
          field('claimer', 'ID من استلم التكت', { max: 22, ph: 'اتركه = ID الخاص بك' , required: false }),
          field('rating', 'تقييم العميل (1-5) — اختياري', { max: 1, required: false }),
          field('duration', 'مدة الحل بالدقائق — اختياري', { max: 5, required: false }),
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
      const ratingRaw = (i.fields.getTextInputValue('rating') || '').trim();
      const durRaw = (i.fields.getTextInputValue('duration') || '').trim();
      if (!ID_RE.test(owner) || !ID_RE.test(claimer)) return replyEphemeral(i, '❌ معرفات الأعضاء غير صحيحة.', COLORS.danger);
      const rating = ratingRaw ? Number(ratingRaw) : null;
      if (rating != null && !(rating >= 1 && rating <= 5)) return replyEphemeral(i, '❌ التقييم يجب أن يكون بين 1 و 5.', COLORS.danger);
      const duration = durRaw ? Number(durRaw) : null;
      if (duration != null && !(duration >= 0)) return replyEphemeral(i, '❌ المدة غير صحيحة.', COLORS.danger);

      const db = getDb();
      const existing = db.prepare('SELECT id FROM ticket_metrics WHERE ticket_id = ?').get(ticketId);
      if (existing) {
        db.prepare('UPDATE ticket_metrics SET reopened = reopened + 1 WHERE id = ?').run(existing.id);
        const claimerStaff = staffService.get(claimer);
        points.add(claimer, 'ticket_reopened', claimerStaff?.team || 'support', { refType: 'ticket', refId: ticketId });
      }
      const res = db.prepare(`INSERT INTO ticket_metrics (ticket_id, ticket_owner, claimer, closer, rating, duration, logged_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(ticketId, owner, claimer, claimer, rating, duration, i.user.id);

      // نقاط الترقية
      const claimerStaff = staffService.get(claimer);
      const team = claimerStaff?.team || 'support';
      let earned = points.add(claimer, 'ticket_closed', team, { refType: 'ticket', refId: ticketId });
      if (rating === 5) earned += points.add(claimer, 'ticket_rating_5', team, { refType: 'ticket', refId: ticketId });
      else if (rating === 4) earned += points.add(claimer, 'ticket_rating_4', team, { refType: 'ticket', refId: ticketId });
      else if (rating != null && rating <= 2) earned += points.add(claimer, 'ticket_rating_low', team, { refType: 'ticket', refId: ticketId });

      const e = embed('🎫 تكت مسجل', null, COLORS.success).addFields(
        { name: 'رقم التكت', value: `\`${ticketId}\``, inline: true },
        { name: 'صاحب التكت', value: `<@${owner}>`, inline: true },
        { name: 'المستلم', value: `<@${claimer}>`, inline: true },
        { name: 'التقييم', value: rating ? '⭐'.repeat(rating) : '—', inline: true },
        { name: 'المدة', value: duration != null ? `${duration} دقيقة` : '—', inline: true },
        { name: 'النقاط', value: `${earned >= 0 ? '+' : ''}${earned}`, inline: true },
        { name: 'سجّله', value: `<@${i.user.id}>`, inline: true },
      ).setFooter({ text: `السجل #${res.lastInsertRowid}${existing ? ' • ⚠️ تكت معاد فتحه' : ''}` });
      await sendToChannel(i.client, 'ticket-logs', { embeds: [e] });
      return i.reply({ embeds: [e], ephemeral: true });
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
