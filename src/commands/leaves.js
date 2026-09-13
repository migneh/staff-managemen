'use strict';
const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LEVELS, LEAVE_TYPES } = require('../constants');
const config = require('../config');
const { getDb } = require('../database');
const leaveService = require('../services/leaves');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, sendToChannel, getChannel, isValidDate, daysBetween, today, dm, log } = require('../utils');

const STATUS_AR = {
  pending: '⏳ معلّق', approved: '✅ معتمد', rejected: '❌ مرفوض', ended: '🏁 منتهي', cancelled: '🚫 ملغى',
};

function leaveEmbed(r, color) {
  return embed(`🏖️ طلب إجازة #${r.id}`, null, color || COLORS.info).addFields(
    { name: 'الإداري', value: `<@${r.user_id}>`, inline: true },
    { name: 'النوع', value: LEAVE_TYPES[r.leave_type] || r.leave_type, inline: true },
    { name: 'الحالة', value: STATUS_AR[r.status] || r.status, inline: true },
    { name: 'من', value: r.start_date, inline: true },
    { name: 'إلى', value: r.end_date, inline: true },
    { name: 'المدة', value: `${daysBetween(r.start_date, r.end_date) + 1} يوم`, inline: true },
    { name: 'السبب', value: r.reason },
    ...(r.reviewed_by ? [{ name: 'المراجع', value: `<@${r.reviewed_by}>${r.review_reason ? ` — ${r.review_reason}` : ''}` }] : []),
    ...(r.cancel_reason ? [{ name: 'سبب الإلغاء', value: r.cancel_reason }] : []),
    ...(r.role_applied_at ? [{ name: 'رتبة الإجازة', value: '🏖️ تم تفعيلها', inline: true }] : []),
  );
}

const reviewRow = (id) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`leave:approve:${id}`).setLabel('موافقة').setEmoji('✅').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`leave:reject:${id}`).setLabel('رفض').setEmoji('❌').setStyle(ButtonStyle.Danger));

async function updateRequestMessage(client, row) {
  if (!row?.message_id) return false;
  try {
    const channel = await getChannel(client, 'leave-requests');
    const message = channel ? await channel.messages.fetch(row.message_id) : null;
    if (!message) return false;
    await message.edit({ content: null, embeds: [leaveEmbed(row, row.status === 'approved' ? COLORS.success : row.status === 'rejected' ? COLORS.danger : COLORS.gray)], components: [] });
    return true;
  } catch { return false; }
}

async function fetchMember(i, userId) {
  try { return i.guild?.members?.fetch ? await i.guild.members.fetch(userId) : null; } catch { return null; }
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
        const rows = getDb().prepare('SELECT * FROM leave_requests WHERE user_id = ? ORDER BY id DESC LIMIT 15').all(i.user.id);
        if (!rows.length) return replyEphemeral(i, 'لا توجد إجازات مسجلة.', COLORS.gray);
        const e = embed('🏖️ إجازاتي', rows.map(r => `\`#${r.id}\` ${STATUS_AR[r.status] || r.status} • ${LEAVE_TYPES[r.leave_type]} • ${r.start_date} → ${r.end_date}${r.cancel_reason ? ` • ${r.cancel_reason}` : ''}`).join('\n'), COLORS.info);
        return i.reply({ embeds: [e], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('cancel-leave').setDescription('إلغاء طلب إجازة لم يبدأ بعد')
        .addIntegerOption(o => o.setName('id').setDescription('رقم طلب الإجازة من /my-leaves').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('سبب الإلغاء — اختياري').setRequired(false).setMaxLength(300)),
      level: LEVELS.STAFF,
      async execute(i) {
        const id = i.options.getInteger('id');
        const reason = i.options.getString('reason') || 'ألغاه صاحب الطلب';
        const db = getDb();
        const r = db.prepare("SELECT * FROM leave_requests WHERE id = ? AND user_id = ? AND status IN ('pending', 'approved')").get(id, i.user.id);
        if (!r) return replyEphemeral(i, '❌ الطلب غير موجود أو لا يمكن إلغاؤه.', COLORS.danger);
        if (r.status === 'approved' && r.start_date <= today()) return replyEphemeral(i, '❌ بدأت الإجازة بالفعل. اطلب من الإدارة استخدام `/end-leave`.', COLORS.danger);
        db.prepare(`UPDATE leave_requests SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now'), cancel_reason = ? WHERE id = ?`).run(i.user.id, reason, r.id);
        const member = await fetchMember(i, i.user.id);
        if (member) await leaveService.syncVacationRole(member);
        const updated = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id);
        await updateRequestMessage(i.client, updated);
        audit.record({ action: 'leave_cancelled', actorId: i.user.id, targetId: i.user.id, details: { requestId: r.id, reason }, channelId: i.channelId });
        return replyEphemeral(i, `✅ تم إلغاء طلب الإجازة **#${r.id}**.`, COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('end-leave').setDescription('إنهاء إجازة إدارياً قبل موعدها')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('سبب الإنهاء').setRequired(true).setMaxLength(300)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const user = i.options.getUser('user');
        const reason = i.options.getString('reason');
        const r = leaveService.activeForUser(user.id)[0];
        if (!r) return replyEphemeral(i, '❌ لا توجد إجازة نشطة لهذا الإداري.', COLORS.danger);
        const db = getDb();
        db.prepare(`UPDATE leave_requests SET status = 'ended', reviewed_by = ?, review_reason = ?, reviewed_at = datetime('now') WHERE id = ?`).run(i.user.id, reason, r.id);
        const member = await fetchMember(i, user.id);
        if (member) {
          const roleResult = await leaveService.syncVacationRole(member);
          if (roleResult.ok && !leaveService.approvedForUser(user.id).length) db.prepare("UPDATE leave_requests SET role_removed_at = COALESCE(role_removed_at, datetime('now')) WHERE id = ?").run(r.id);
        }
        const otherActive = leaveService.activeForUser(user.id).some(row => row.id !== r.id);
        if (!otherActive && staffService.get(user.id)?.status === 'on_leave') staffService.update(user.id, {
          status: 'active', absence_alert_level: 0, last_activity: new Date().toISOString().replace('T', ' ').slice(0, 19),
        });
        const updated = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id);
        await updateRequestMessage(i.client, updated);
        await dm(i.client, user.id, { embeds: [embed('🏁 انتهت إجازتك مبكراً', `تم إنهاء الإجازة **#${r.id}** إدارياً.\n**السبب:** ${reason}`, COLORS.info)] });
        audit.record({ action: 'leave_ended_early', actorId: i.user.id, targetId: user.id, details: { requestId: r.id, reason }, channelId: i.channelId });
        await log(i.client, '🏁 إنهاء إجازة مبكر', `<@${user.id}> — #${r.id} بواسطة <@${i.user.id}>\n${reason}`, COLORS.info);
        return replyEphemeral(i, `✅ تم إنهاء إجازة <@${user.id}>.`, COLORS.success);
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
      const overlap = leaveService.userHasOverlap(i.user.id, start, end);
      if (overlap) return replyEphemeral(i, `❌ لديك طلب/إجازة متداخلة: **#${overlap.id}** (${overlap.start_date} → ${overlap.end_date}).`, COLORS.danger);

      const res = getDb().prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date) VALUES (?, ?, ?, ?, ?)`).run(i.user.id, type, reason, start, end);
      const r = getDb().prepare('SELECT * FROM leave_requests WHERE id = ?').get(res.lastInsertRowid);
      const warn = leaveService.concurrentApproved(start, end) >= config.leave.maxConcurrent ? `\n⚠️ **تنبيه:** يوجد بالفعل ${config.leave.maxConcurrent} إداريين بإجازة متداخلة؛ قد يُرفض الطلب عند المراجعة.` : '';
      const msg = await sendToChannel(i.client, 'leave-requests', { content: warn || undefined, embeds: [leaveEmbed(r)], components: [reviewRow(r.id)] });
      if (msg) getDb().prepare('UPDATE leave_requests SET message_id = ? WHERE id = ?').run(msg.id, r.id);
      audit.record({ action: 'leave_requested', actorId: i.user.id, targetId: i.user.id, details: { requestId: r.id, type, start, end }, channelId: i.channelId });
      return replyEphemeral(i, `✅ تم إرسال طلب الإجازة **#${r.id}** للمراجعة.`, COLORS.success);
    },

    'leave:approve': async (i, [id]) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك صلاحية الموافقة.', COLORS.danger);
      const db = getDb();
      const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(id));
      if (!r || r.status !== 'pending') return replyEphemeral(i, '❌ الطلب غير موجود أو تمت مراجعته.', COLORS.danger);
      if (leaveService.concurrentApproved(r.start_date, r.end_date, r.id) >= config.leave.maxConcurrent)
        return replyEphemeral(i, `❌ تم بلوغ الحد الأقصى (${config.leave.maxConcurrent}) للمجازين في هذه الفترة.`, COLORS.danger);
      if (leaveService.userHasOverlap(r.user_id, r.start_date, r.end_date, { excludeId: r.id, includePending: false }))
        return replyEphemeral(i, '❌ لدى الإداري إجازة معتمدة متداخلة بالفعل.', COLORS.danger);
      db.prepare(`UPDATE leave_requests SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`).run(i.user.id, r.id);
      const member = await fetchMember(i, r.user_id);
      const roleResult = member ? await staffService.addVacationRole(member) : { ok: false, missing: true };
      if (roleResult.ok) db.prepare("UPDATE leave_requests SET role_applied_at = COALESCE(role_applied_at, datetime('now')) WHERE id = ?").run(r.id);
      if (r.start_date <= today() && staffService.get(r.user_id)?.status !== 'resigned') staffService.setStatus(r.user_id, 'on_leave');
      audit.record({ action: 'leave_approved', actorId: i.user.id, targetId: r.user_id, details: { requestId: r.id, start: r.start_date, end: r.end_date, vacationRole: roleResult.ok }, channelId: i.channelId });
      const updated = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id);
      await i.update({ content: null, embeds: [leaveEmbed(updated, COLORS.success)], components: [] });
      await dm(i.client, r.user_id, { embeds: [embed('✅ تمت الموافقة على إجازتك', `من **${r.start_date}** إلى **${r.end_date}**\nتم تفعيل رتبة **in vacation** تلقائياً${roleResult.ok ? '' : '، لكن لم أستطع العثور على الرتبة/تفعيلها؛ راجع /setup'} .`, COLORS.success)] });
      return log(i.client, '🏖️ موافقة على إجازة', `<@${r.user_id}> — #${r.id} بواسطة <@${i.user.id}>${roleResult.ok ? '' : '\n⚠️ رتبة in vacation لم تُفعّل'}`, COLORS.success);
    },

    'leave:reject': async (i, [id]) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك صلاحية الرفض.', COLORS.danger);
      const m = new ModalBuilder().setCustomId(`leave:rejectmodal:${id}`).setTitle('❌ سبب الرفض');
      m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('السبب').setStyle(TextInputStyle.Paragraph).setMaxLength(300).setRequired(true)));
      return i.showModal(m);
    },

    'leave:rejectmodal': async (i, [id]) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك الصلاحية.', COLORS.danger);
      const db = getDb();
      const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(id));
      if (!r || r.status !== 'pending') return replyEphemeral(i, '❌ الطلب غير موجود أو تمت مراجعته.', COLORS.danger);
      const reason = i.fields.getTextInputValue('reason').trim();
      db.prepare(`UPDATE leave_requests SET status = 'rejected', reviewed_by = ?, review_reason = ?, reviewed_at = datetime('now') WHERE id = ?`).run(i.user.id, reason, r.id);
      audit.record({ action: 'leave_rejected', actorId: i.user.id, targetId: r.user_id, details: { requestId: r.id, reason }, channelId: i.channelId });
      const updated = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id);
      await updateRequestMessage(i.client, updated, COLORS.danger);
      await replyEphemeral(i, `تم رفض الطلب #${r.id}.`, COLORS.danger);
      await dm(i.client, r.user_id, { embeds: [embed('❌ تم رفض طلب إجازتك', `**السبب:** ${reason}`, COLORS.danger)] });
      return log(i.client, '🏖️ رفض إجازة', `<@${r.user_id}> — #${r.id} بواسطة <@${i.user.id}>\n${reason}`, COLORS.danger);
    },
  },
};
