'use strict';
const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LEVELS } = require('../constants');
const config = require('../config');
const { getDb } = require('../database');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, sendToChannel, isValidDate, daysBetween, today, dm, log } = require('../utils');

const STATUS_AR = { pending: '⏳ معلّق', accepted: '✅ مقبول', rejected: '❌ مرفوض', on_hold: '⏸️ معلّق لمقابلة' };

function resignEmbed(r, color) {
  return embed(`📤 طلب استقالة #${r.id}`, null, color || COLORS.warning).addFields(
    { name: 'الإداري', value: `<@${r.user_id}>`, inline: true },
    { name: 'الرتبة', value: `${r.rank || '—'}`, inline: true },
    { name: 'الحالة', value: STATUS_AR[r.status], inline: true },
    { name: 'آخر يوم', value: r.last_day, inline: true },
    { name: 'فترة الإشعار', value: `${daysBetween(r.created_at.slice(0, 10), r.last_day)} يوم`, inline: true },
    { name: 'السبب', value: r.reason },
    ...(r.notes ? [{ name: 'ملاحظات', value: r.notes }] : []),
    ...(r.reviewed_by ? [{ name: 'المراجع', value: `<@${r.reviewed_by}>${r.review_reason ? ` — ${r.review_reason}` : ''}` }] : []),
  ).setFooter({ text: '🔒 سري — للإدارة فقط' });
}

const reviewRow = (id) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`resign:accept:${id}`).setLabel('قبول (Boss)').setEmoji('✅').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`resign:reject:${id}`).setLabel('رفض').setEmoji('❌').setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId(`resign:hold:${id}`).setLabel('تعليق — طلب مقابلة').setEmoji('⏸️').setStyle(ButtonStyle.Secondary));

async function decide(i, id, status) {
  const db = getDb();
  const r = db.prepare('SELECT * FROM resignations WHERE id = ?').get(Number(id));
  if (!r || !['pending', 'on_hold'].includes(r.status)) return replyEphemeral(i, '❌ الطلب غير موجود أو تمت مراجعته.', COLORS.danger);
  const reason = i.fields ? i.fields.getTextInputValue('reason').trim() : null;
  db.prepare(`UPDATE resignations SET status = ?, reviewed_by = ?, review_reason = ?, reviewed_at = datetime('now') WHERE id = ?`).run(status, i.user.id, reason, r.id);
  audit.record({ action: `resignation_${status}`, actorId: i.user.id, targetId: r.user_id, details: { requestId: r.id, reason }, channelId: i.channelId });
  const updated = db.prepare('SELECT * FROM resignations WHERE id = ?').get(r.id);

  let color = COLORS.gray, dmEmbed;
  if (status === 'accepted') {
    color = COLORS.success;
    staffService.setStatus(r.user_id, 'resigned');
    const member = await i.guild.members.fetch(r.user_id).catch(() => null);
    if (member) await staffService.removeAllStaffRoles(member);
    dmEmbed = embed('👋 تم قبول استقالتك', `شكراً لك على كل ما قدمته للفريق. تمت إزالة الرتب الإدارية.\n${reason ? `**رسالة الإدارة:** ${reason}` : ''}\nنتمنى لك التوفيق 🌹`, COLORS.success);
  } else if (status === 'rejected') {
    color = COLORS.danger;
    dmEmbed = embed('❌ تم رفض طلب استقالتك', `**السبب:** ${reason}`, COLORS.danger);
  } else {
    dmEmbed = embed('⏸️ تم تعليق طلب استقالتك', `الإدارة تطلب مقابلة معك قبل اتخاذ القرار.\n${reason ? `**ملاحظة:** ${reason}` : ''}`, COLORS.warning);
  }
  const payload = { embeds: [resignEmbed(updated, color)], components: status === 'on_hold' ? [reviewRow(r.id)] : [] };
  if (i.isModalSubmit()) { if (i.message) await i.message.edit(payload).catch(() => {}); await replyEphemeral(i, `تم تحديث الطلب #${r.id} → ${STATUS_AR[status]}`, color); }
  else await i.update(payload);
  await dm(i.client, r.user_id, { embeds: [dmEmbed] });
  return log(i.client, `📤 استقالة: ${STATUS_AR[status]}`, `<@${r.user_id}> — #${r.id} بواسطة <@${i.user.id}>`, color);
}

const reasonModal = (id, action, title) => {
  const m = new ModalBuilder().setCustomId(`resign:${action}modal:${id}`).setTitle(title);
  m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('السبب / الملاحظة').setStyle(TextInputStyle.Paragraph).setMaxLength(300).setRequired(action === 'reject')));
  return m;
};

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('resign').setDescription('تقديم طلب استقالة'),
      level: LEVELS.STAFF,
      async execute(i) {
        const pending = getDb().prepare(`SELECT id FROM resignations WHERE user_id = ? AND status IN ('pending','on_hold')`).get(i.user.id);
        if (pending) return replyEphemeral(i, `❌ لديك طلب استقالة قيد المراجعة (#${pending.id}).`, COLORS.danger);
        const m = new ModalBuilder().setCustomId('resign:modal').setTitle('📤 طلب استقالة');
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('سبب الاستقالة (إجباري)').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('last_day').setLabel(`آخر يوم (YYYY-MM-DD) — إشعار ${config.resignation.noticeDays} أيام`).setStyle(TextInputStyle.Short).setMaxLength(10).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('notes').setLabel('ملاحظات إضافية — اختياري').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false)),
        );
        return i.showModal(m);
      },
    },
  ],

  components: {
    'resign:modal': async (i) => {
      const reason = i.fields.getTextInputValue('reason').trim();
      const lastDay = i.fields.getTextInputValue('last_day').trim();
      const notes = (i.fields.getTextInputValue('notes') || '').trim() || null;
      if (!isValidDate(lastDay)) return replyEphemeral(i, '❌ صيغة التاريخ غير صحيحة. استخدم YYYY-MM-DD.', COLORS.danger);
      if (lastDay < today()) return replyEphemeral(i, '❌ آخر يوم لا يمكن أن يكون في الماضي.', COLORS.danger);
      const notice = daysBetween(today(), lastDay);
      const s = staffService.get(i.user.id);
      const res = getDb().prepare(`INSERT INTO resignations (user_id, reason, last_day, notes, team, rank) VALUES (?, ?, ?, ?, ?, ?)`).run(i.user.id, reason, lastDay, notes, s?.team, s?.rank);
      const r = getDb().prepare('SELECT * FROM resignations WHERE id = ?').get(res.lastInsertRowid);
      const warn = notice < config.resignation.noticeDays ? `⚠️ **فترة الإشعار أقل من ${config.resignation.noticeDays} أيام** — تحتاج قرار Boss للاستقالة الفورية.` : undefined;
      const msg = await sendToChannel(i.client, 'resignation-requests', { content: warn, embeds: [resignEmbed(r)], components: [reviewRow(r.id)] });
      if (msg) getDb().prepare('UPDATE resignations SET message_id = ? WHERE id = ?').run(msg.id, r.id);
      return replyEphemeral(i, `✅ تم إرسال طلب استقالتك **#${r.id}** للإدارة بسرية تامة.`, COLORS.success);
    },
    'resign:accept': async (i, [id]) => {
      if (i.staffLevel < LEVELS.BOSS) return replyEphemeral(i, '❌ قبول الاستقالة من صلاحية Boss فقط.', COLORS.danger);
      return i.showModal(reasonModal(id, 'accept', '✅ قبول الاستقالة — رسالة وداع (اختياري)'));
    },
    'resign:acceptmodal': async (i, [id]) => { if (i.staffLevel < LEVELS.BOSS) return replyEphemeral(i, '❌ Boss فقط.', COLORS.danger); return decide(i, id, 'accepted'); },
    'resign:reject': async (i, [id]) => {
      if (i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك الصلاحية.', COLORS.danger);
      return i.showModal(reasonModal(id, 'reject', '❌ سبب رفض الاستقالة'));
    },
    'resign:rejectmodal': async (i, [id]) => { if (i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك الصلاحية.', COLORS.danger); return decide(i, id, 'rejected'); },
    'resign:hold': async (i, [id]) => {
      if (i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك الصلاحية.', COLORS.danger);
      return i.showModal(reasonModal(id, 'hold', '⏸️ تعليق — ملاحظة للإداري'));
    },
    'resign:holdmodal': async (i, [id]) => { if (i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك الصلاحية.', COLORS.danger); return decide(i, id, 'on_hold'); },
  },
};
