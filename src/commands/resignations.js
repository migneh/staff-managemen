'use strict';
const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LEVELS } = require('../constants');
const config = require('../config');
const { getDb } = require('../database');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, sendToChannel, getChannel, isValidDate, daysBetween, today, dm, log } = require('../utils');

const STATUS_AR = { pending: '⏳ معلّق', accepted: '✅ مقبول', rejected: '❌ مرفوض', on_hold: '⏸️ معلّق لمقابلة', withdrawn: '↩️ مسحوب' };

function resignEmbed(r, color) {
  return embed(`📤 طلب استقالة #${r.id}`, null, color || COLORS.warning).addFields(
    { name: 'الإداري', value: `<@${r.user_id}>`, inline: true },
    { name: 'الرتبة وقت الطلب', value: `${r.rank || '—'}`, inline: true },
    { name: 'الحالة', value: STATUS_AR[r.status] || r.status, inline: true },
    { name: 'آخر يوم', value: r.last_day, inline: true },
    { name: 'فترة الإشعار', value: `${daysBetween(r.created_at.slice(0, 10), r.last_day)} يوم`, inline: true },
    { name: 'السبب', value: r.reason },
    ...(r.notes ? [{ name: 'ملاحظات', value: r.notes }] : []),
    ...(r.reviewed_by ? [{ name: 'المراجع', value: `<@${r.reviewed_by}>${r.review_reason ? ` — ${r.review_reason}` : ''}` }] : []),
    ...(r.withdraw_reason ? [{ name: 'سبب السحب', value: r.withdraw_reason }] : []),
  ).setFooter({ text: '🔒 سري — للإدارة فقط' });
}

const reviewRow = (id) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`resign:accept:${id}`).setLabel('قبول (Boss)').setEmoji('✅').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`resign:reject:${id}`).setLabel('رفض').setEmoji('❌').setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId(`resign:hold:${id}`).setLabel('تعليق — طلب مقابلة').setEmoji('⏸️').setStyle(ButtonStyle.Secondary));

async function fetchMember(i, userId) {
  try { return i.guild?.members?.fetch ? await i.guild.members.fetch(userId) : null; } catch { return null; }
}

async function updateRequestMessage(client, row, color) {
  if (!row?.message_id) return false;
  try {
    const channel = await getChannel(client, 'resignation-requests');
    const message = channel ? await channel.messages.fetch(row.message_id) : null;
    if (!message) return false;
    await message.edit({ content: null, embeds: [resignEmbed(row, color)], components: row.status === 'on_hold' ? [reviewRow(row.id)] : [] });
    return true;
  } catch { return false; }
}

async function decide(i, id, status) {
  const db = getDb();
  const r = db.prepare('SELECT * FROM resignations WHERE id = ?').get(Number(id));
  if (!r || !['pending', 'on_hold'].includes(r.status)) return replyEphemeral(i, '❌ الطلب غير موجود أو تمت مراجعته.', COLORS.danger);
  const reason = i.fields ? (i.fields.getTextInputValue('reason') || '').trim() || null : null;
  db.prepare(`UPDATE resignations SET status = ?, reviewed_by = ?, review_reason = ?, reviewed_at = datetime('now') WHERE id = ?`).run(status, i.user.id, reason, r.id);
  audit.record({ action: `resignation_${status}`, actorId: i.user.id, targetId: r.user_id, details: { requestId: r.id, reason }, channelId: i.channelId });

  let color = COLORS.gray;
  let dmEmbed;
  if (status === 'accepted') {
    color = COLORS.success;
    staffService.setStatus(r.user_id, 'resigned');
    // إلغاء أي إجازة مستقبلية/نشطة حتى لا يعيد المجدول رتبة الإجازة بعد قبول الاستقالة.
    db.prepare(`UPDATE leave_requests SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now'), cancel_reason = 'إلغاء تلقائي بسبب قبول الاستقالة' WHERE user_id = ? AND status IN ('pending', 'approved')`).run(i.user.id, r.user_id);
    const member = await fetchMember(i, r.user_id);
    let staffRoleResult = true;
    let roleResult = null;
    if (member) {
      staffRoleResult = await staffService.removeAllStaffRoles(member);
      roleResult = await staffService.removeVacationRole(member);
      if (staffRoleResult && roleResult.ok) db.prepare("UPDATE resignations SET roles_removed_at = datetime('now') WHERE id = ?").run(r.id);
    }
    dmEmbed = embed('👋 تم قبول استقالتك', `شكراً لك على كل ما قدمته للفريق. تمت إزالة الرتب الإدارية${roleResult?.ok === false ? '، لكن تعذرت إزالة رتبة الإجازة تلقائياً' : ' ورتبة in vacation'}.\n${reason ? `**رسالة الإدارة:** ${reason}` : ''}\nنتمنى لك التوفيق 🌹`, COLORS.success);
    audit.record({ action: 'resignation_roles_removed', actorId: i.user.id, targetId: r.user_id, details: { requestId: r.id, staffRolesRemoved: staffRoleResult, vacationRoleRemoved: roleResult?.ok !== false }, channelId: i.channelId });
  } else if (status === 'rejected') {
    color = COLORS.danger;
    dmEmbed = embed('❌ تم رفض طلب استقالتك', `**السبب:** ${reason || 'لم يذكر المراجع سبباً.'}`, COLORS.danger);
  } else {
    dmEmbed = embed('⏸️ تم تعليق طلب استقالتك', `الإدارة تطلب مقابلة معك قبل اتخاذ القرار.\n${reason ? `**ملاحظة:** ${reason}` : ''}`, COLORS.warning);
  }

  const updated = db.prepare('SELECT * FROM resignations WHERE id = ?').get(r.id);
  await updateRequestMessage(i.client, updated, color);
  if (i.isModalSubmit()) await replyEphemeral(i, `تم تحديث الطلب #${r.id} → ${STATUS_AR[status]}`, color);
  else if (!i.replied && !i.deferred) await i.update({ content: null, embeds: [resignEmbed(updated, color)], components: status === 'on_hold' ? [reviewRow(r.id)] : [] });
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
        const staff = staffService.get(i.user.id);
        if (!staff || staff.status === 'resigned') return replyEphemeral(i, '❌ لا يمكن تقديم استقالة لستاف غير مسجل أو مستقيل.', COLORS.danger);
        const pending = getDb().prepare(`SELECT id FROM resignations WHERE user_id = ? AND status IN ('pending','on_hold')`).get(i.user.id);
        if (pending) return replyEphemeral(i, `❌ لديك طلب استقالة قيد المراجعة (#${pending.id}). يمكنك سحبه عبر \/withdraw-resignation.`, COLORS.danger);
        const m = new ModalBuilder().setCustomId('resign:modal').setTitle('📤 طلب استقالة');
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('سبب الاستقالة (إجباري)').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('last_day').setLabel(`آخر يوم (YYYY-MM-DD) — إشعار ${config.resignation.noticeDays} أيام`).setStyle(TextInputStyle.Short).setMaxLength(10).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('notes').setLabel('ملاحظات إضافية — اختياري').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false)),
        );
        return i.showModal(m);
      },
    },
    {
      data: new SlashCommandBuilder().setName('withdraw-resignation').setDescription('سحب طلب الاستقالة قبل اعتماده')
        .addIntegerOption(o => o.setName('id').setDescription('رقم طلب الاستقالة').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('سبب السحب — اختياري').setMaxLength(300)),
      level: LEVELS.STAFF,
      async execute(i) {
        const id = i.options.getInteger('id');
        const reason = i.options.getString('reason') || 'سحب الطلب من صاحبه';
        const db = getDb();
        const r = db.prepare("SELECT * FROM resignations WHERE id = ? AND user_id = ? AND status IN ('pending', 'on_hold')").get(id, i.user.id);
        if (!r) return replyEphemeral(i, '❌ الطلب غير موجود أو تم اتخاذ قرار بشأنه.', COLORS.danger);
        db.prepare(`UPDATE resignations SET status = 'withdrawn', withdrawn_by = ?, withdrawn_at = datetime('now'), withdraw_reason = ? WHERE id = ?`).run(i.user.id, reason, r.id);
        const updated = db.prepare('SELECT * FROM resignations WHERE id = ?').get(r.id);
        await updateRequestMessage(i.client, updated, COLORS.gray);
        audit.record({ action: 'resignation_withdrawn', actorId: i.user.id, targetId: i.user.id, details: { requestId: r.id, reason }, channelId: i.channelId });
        await log(i.client, '↩️ سحب استقالة', `<@${i.user.id}> — #${r.id}`, COLORS.gray);
        return replyEphemeral(i, `✅ تم سحب طلب الاستقالة **#${r.id}**.`, COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('review-resignations').setDescription('عرض الاستقالات المعلّقة — للإدارة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const rows = getDb().prepare(`SELECT * FROM resignations WHERE status IN ('pending', 'on_hold') ORDER BY last_day, created_at`).all();
        if (!rows.length) return replyEphemeral(i, '✅ لا توجد استقالات معلّقة.', COLORS.success);
        await i.reply({ embeds: [embed('📤 الاستقالات المعلّقة', `العدد: **${rows.length}**\n🔒 البيانات سرية ولا تظهر إلا للإدارة.`, COLORS.warning)], ephemeral: true });
        for (const r of rows.slice(0, 10)) await i.followUp({ embeds: [resignEmbed(r)], components: [reviewRow(r.id)], ephemeral: true });
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
      const duplicate = getDb().prepare(`SELECT id FROM resignations WHERE user_id = ? AND status IN ('pending','on_hold')`).get(i.user.id);
      if (duplicate) return replyEphemeral(i, `❌ لديك طلب استقالة قيد المراجعة (#${duplicate.id}).`, COLORS.danger);
      const res = getDb().prepare(`INSERT INTO resignations (user_id, reason, last_day, notes, team, rank) VALUES (?, ?, ?, ?, ?, ?)`).run(i.user.id, reason, lastDay, notes, s?.team, s?.rank);
      const r = getDb().prepare('SELECT * FROM resignations WHERE id = ?').get(res.lastInsertRowid);
      const warn = notice < config.resignation.noticeDays ? `⚠️ **فترة الإشعار أقل من ${config.resignation.noticeDays} أيام** — تحتاج قرار Boss للاستقالة الفورية.` : undefined;
      const msg = await sendToChannel(i.client, 'resignation-requests', { content: warn, embeds: [resignEmbed(r)], components: [reviewRow(r.id)] });
      if (msg) getDb().prepare('UPDATE resignations SET message_id = ? WHERE id = ?').run(msg.id, r.id);
      audit.record({ action: 'resignation_requested', actorId: i.user.id, targetId: i.user.id, details: { requestId: r.id, lastDay }, channelId: i.channelId });
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
