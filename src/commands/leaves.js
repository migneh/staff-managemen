'use strict';
const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LEVELS, LEAVE_TYPES } = require('../constants');
const config = require('../config');
const { getDb } = require('../database');
const staffService = require('../services/staff');
const { embed, COLORS, replyEphemeral, sendToChannel, isValidDate, daysBetween, today, dm, log } = require('../utils');

const STATUS_AR = { pending: '⏳ معلّق', approved: '✅ معتمد', rejected: '❌ مرفوض', ended: '🏁 منتهي' };

function leaveEmbed(r, color) {
  return embed(`🏖️ طلب إجازة #${r.id}`, null, color || COLORS.info).addFields(
    { name: 'الإداري', value: `<@${r.user_id}>`, inline: true },
    { name: 'النوع', value: LEAVE_TYPES[r.leave_type] || r.leave_type, inline: true },
    { name: 'الحالة', value: STATUS_AR[r.status], inline: true },
    { name: 'من', value: r.start_date, inline: true },
    { name: 'إلى', value: r.end_date, inline: true },
    { name: 'المدة', value: `${daysBetween(r.start_date, r.end_date) + 1} يوم`, inline: true },
    { name: 'السبب', value: r.reason },
    ...(r.reviewed_by ? [{ name: 'المراجع', value: `<@${r.reviewed_by}>${r.review_reason ? ` — ${r.review_reason}` : ''}` }] : []),
  );
}

const reviewRow = (id) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`leave:approve:${id}`).setLabel('موافقة').setEmoji('✅').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`leave:reject:${id}`).setLabel('رفض').setEmoji('❌').setStyle(ButtonStyle.Danger));

function concurrentApproved(start, end) {
  return getDb().prepare(`SELECT COUNT(*) c FROM leave_requests WHERE status = 'approved' AND start_date <= ? AND end_date >= ?`).get(end, start).c;
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('request-leave').setDescription('تقديم طلب إجازة')
        .addStringOption(o => o.setName('type').setDescription('نوع الإجازة').setRequired(true)
          .addChoices(...Object.entries(LEAVE_TYPES).map(([v, n]) => ({ name: n, value: v })))),
      level: LEVELS.STAFF,
      async execute(i) {
        const pending = getDb().prepare(`SELECT id FROM leave_requests WHERE user_id = ? AND status = 'pending'`).get(i.user.id);
        if (pending) return replyEphemeral(i, `❌ لديك طلب معلّق بالفعل (#${pending.id}).`, COLORS.danger);
        const type = i.options.getString('type');
        const m = new ModalBuilder().setCustomId(`leave:modal:${type}`).setTitle(`🏖️ طلب إجازة — ${LEAVE_TYPES[type]}`);
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('السبب (إجباري)').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('start').setLabel('تاريخ البداية (YYYY-MM-DD)').setStyle(TextInputStyle.Short).setMaxLength(10).setRequired(true).setPlaceholder(today())),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('end').setLabel('تاريخ النهاية (YYYY-MM-DD)').setStyle(TextInputStyle.Short).setMaxLength(10).setRequired(true)),
        );
        return i.showModal(m);
      },
    },
    {
      data: new SlashCommandBuilder().setName('review-leaves').setDescription('مراجعة طلبات الإجازة المعلّقة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const rows = getDb().prepare(`SELECT * FROM leave_requests WHERE status = 'pending' ORDER BY created_at`).all();
        if (!rows.length) return replyEphemeral(i, '✅ لا توجد طلبات إجازة معلّقة.', COLORS.success);
        await i.reply({ embeds: [embed('⏳ طلبات الإجازة المعلّقة', `العدد: **${rows.length}**`, COLORS.info)], ephemeral: true });
        for (const r of rows.slice(0, 10)) await i.followUp({ embeds: [leaveEmbed(r)], components: [reviewRow(r.id)], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('my-leaves').setDescription('عرض إجازاتي'),
      level: LEVELS.STAFF,
      async execute(i) {
        const rows = getDb().prepare('SELECT * FROM leave_requests WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(i.user.id);
        if (!rows.length) return replyEphemeral(i, 'لا توجد إجازات مسجلة.', COLORS.gray);
        const e = embed('🏖️ إجازاتي', rows.map(r => `\`#${r.id}\` ${STATUS_AR[r.status]} • ${LEAVE_TYPES[r.leave_type]} • ${r.start_date} → ${r.end_date}`).join('\n'), COLORS.info);
        return i.reply({ embeds: [e], ephemeral: true });
      },
    },
  ],

  components: {
    'leave:modal': async (i, [type]) => {
      const reason = i.fields.getTextInputValue('reason').trim();
      const start = i.fields.getTextInputValue('start').trim();
      const end = i.fields.getTextInputValue('end').trim();
      if (!isValidDate(start) || !isValidDate(end)) return replyEphemeral(i, '❌ صيغة التاريخ غير صحيحة. استخدم YYYY-MM-DD.', COLORS.danger);
      const days = daysBetween(start, end) + 1;
      if (days < 1) return replyEphemeral(i, '❌ تاريخ النهاية قبل البداية.', COLORS.danger);
      if (end < today()) return replyEphemeral(i, '❌ لا يمكن طلب إجازة في الماضي.', COLORS.danger);
      if (days > config.leave.maxDays) return replyEphemeral(i, `❌ الحد الأقصى للإجازة ${config.leave.maxDays} يوم.`, COLORS.danger);

      const res = getDb().prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date) VALUES (?, ?, ?, ?, ?)`).run(i.user.id, type, reason, start, end);
      const r = getDb().prepare('SELECT * FROM leave_requests WHERE id = ?').get(res.lastInsertRowid);
      const warn = concurrentApproved(start, end) >= config.leave.maxConcurrent ? `\n⚠️ **تنبيه:** يوجد بالفعل ${config.leave.maxConcurrent} مجازين في هذه الفترة.` : '';
      const msg = await sendToChannel(i.client, 'leave-requests', { content: warn || undefined, embeds: [leaveEmbed(r)], components: [reviewRow(r.id)] });
      if (msg) getDb().prepare('UPDATE leave_requests SET message_id = ? WHERE id = ?').run(msg.id, r.id);
      return replyEphemeral(i, `✅ تم إرسال طلب الإجازة **#${r.id}** للمراجعة.`, COLORS.success);
    },

    'leave:approve': async (i, [id]) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك صلاحية الموافقة.', COLORS.danger);
      const db = getDb();
      const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(id));
      if (!r || r.status !== 'pending') return replyEphemeral(i, '❌ الطلب غير موجود أو تمت مراجعته.', COLORS.danger);
      if (concurrentApproved(r.start_date, r.end_date) >= config.leave.maxConcurrent)
        return replyEphemeral(i, `❌ تم بلوغ الحد الأقصى (${config.leave.maxConcurrent}) للمجازين في هذه الفترة.`, COLORS.danger);
      db.prepare(`UPDATE leave_requests SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`).run(i.user.id, r.id);
      if (r.start_date <= today()) staffService.setStatus(r.user_id, 'on_leave');
      const updated = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id);
      await i.update({ content: null, embeds: [leaveEmbed(updated, COLORS.success)], components: [] });
      await dm(i.client, r.user_id, { embeds: [embed('✅ تمت الموافقة على إجازتك', `من **${r.start_date}** إلى **${r.end_date}**\nسيتم إيقاف احتساب الغياب خلال هذه الفترة.`, COLORS.success)] });
      return log(i.client, '🏖️ موافقة على إجازة', `<@${r.user_id}> — #${r.id} بواسطة <@${i.user.id}>`, COLORS.success);
    },

    'leave:reject': async (i, [id]) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك صلاحية الرفض.', COLORS.danger);
      const m = new ModalBuilder().setCustomId(`leave:rejectmodal:${id}`).setTitle('❌ سبب الرفض');
      m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('السبب').setStyle(TextInputStyle.Paragraph).setMaxLength(300).setRequired(true)));
      return i.showModal(m);
    },

    'leave:rejectmodal': async (i, [id]) => {
      const db = getDb();
      const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(id));
      if (!r || r.status !== 'pending') return replyEphemeral(i, '❌ الطلب غير موجود أو تمت مراجعته.', COLORS.danger);
      const reason = i.fields.getTextInputValue('reason').trim();
      db.prepare(`UPDATE leave_requests SET status = 'rejected', reviewed_by = ?, review_reason = ?, reviewed_at = datetime('now') WHERE id = ?`).run(i.user.id, reason, r.id);
      const updated = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id);
      if (i.message) await i.message.edit({ content: null, embeds: [leaveEmbed(updated, COLORS.danger)], components: [] }).catch(() => {});
      await replyEphemeral(i, `تم رفض الطلب #${r.id}.`, COLORS.danger);
      await dm(i.client, r.user_id, { embeds: [embed('❌ تم رفض طلب إجازتك', `**السبب:** ${reason}`, COLORS.danger)] });
      return log(i.client, '🏖️ رفض إجازة', `<@${r.user_id}> — #${r.id} بواسطة <@${i.user.id}>\n${reason}`, COLORS.danger);
    },
  },
};
