'use strict';
const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { LEVELS, LEAVE_TYPES, LEAVE_RULES } = require('../constants');
const settings = require('../services/settings');
const { getDb } = require('../database');
const leaveService = require('../services/leaves');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, sendToChannel, getChannel, isValidDate, today, addDays, dm, log } = require('../utils');
const kit = require('../ui/kit');

const STATUS_AR = { pending: '⏳ معلّق', approved: '✅ معتمد', rejected: '❌ مرفوض', ended: '🏁 منتهي', cancelled: '🚫 ملغى' };
const STATUS_COLOR = { pending: COLORS.warning, approved: COLORS.success, rejected: COLORS.danger, ended: COLORS.gray, cancelled: COLORS.gray };

function leaveEmbed(r, color) {
  const rule = LEAVE_RULES[r.leave_type] || {};
  const dur = r.duration_days ?? (isValidDate(r.start_date) && isValidDate(r.end_date) ? leaveService.durationDays(r.start_date, r.end_date) : null);
  const e = embed(`${rule.emoji || '🏖️'} إجازة #${r.id} — ${LEAVE_TYPES[r.leave_type] || r.leave_type}`, null, color || STATUS_COLOR[r.status] || COLORS.info)
    .addFields(
      { name: 'الإداري', value: `<@${r.user_id}>`, inline: true },
      { name: 'الحالة', value: STATUS_AR[r.status] || r.status, inline: true },
      { name: 'المدة', value: dur ? `**${dur}** ${kit.daysWord(dur)}` : r.start_date ? `${r.start_date} → ${r.end_date}` : '—', inline: true },
      { name: 'من', value: r.start_date ? `${kit.tsDate(r.start_date)} • ${kit.relativeDays(kit.daysFromToday(r.start_date))}` : '—', inline: true },
      { name: 'إلى', value: r.end_date ? `${kit.tsDate(r.end_date)} • ${kit.relativeDays(kit.daysFromToday(r.end_date))}` : '—', inline: true },
      { name: 'السبب', value: r.reason || '—' },
    );
  if (r.notice_hours != null) e.addFields({ name: '⏰ الإشعار', value: `${r.notice_hours} ساعة`, inline: true });
  if (r.attachment_url) e.addFields({ name: '📎 مرفق', value: `[فتح](${r.attachment_url})`, inline: true });
  if (r.extended_count) e.addFields({ name: '↗️ تمديد', value: `${r.extended_count} مرة`, inline: true });
  if (r.reviewed_by) e.addFields({ name: 'المراجع', value: `<@${r.reviewed_by}>${r.review_reason ? ` — ${r.review_reason}` : ''}` });
  if (r.cancel_reason) e.addFields({ name: 'سبب الإلغاء', value: r.cancel_reason });
  if (r.end_reason) e.addFields({ name: 'سبب الإنهاء', value: { auto: 'انتهاء المدة', early: 'إنهاء مبكر', resignation: 'استقالة', admin: 'إدارياً' }[r.end_reason] || r.end_reason, inline: true });
  if (r.role_applied_at) e.addFields({ name: '🏖️ رتبة in vacation', value: r.role_removed_at ? `أُزيلت ${kit.tsRelative(r.role_removed_at)}` : 'مفعّلة', inline: true });
  e.setFooter({ text: `#${r.id} • ${LEAVE_TYPES[r.leave_type] || r.leave_type} • ${STATUS_AR[r.status] || r.status}` });
  return e;
}

function coverageField(start, end) {
  const cov = leaveService.coverageBetween(start, end);
  const bar = kit.coverageBar(cov.peak, cov.max);
  const day = cov.peakDay !== start ? ` (ذروة ${kit.tsDate(cov.peakDay)})` : '';
  return { name: `👥 التغطية خلال الفترة`, value: `${bar}${day}\n${cov.peak >= cov.max ? '⚠️ الفترة ممتلئة — قد يُرفض الطلب' : cov.peak >= cov.max - 1 ? '🟡 الفترة شبه ممتلئة' : '✅ توجد سعة'}` };
}

function calendarEmbed(start, days) {
  const lines = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const cov = leaveService.coverageFor(date);
    const people = cov.rows.length ? cov.rows.map(r => `<@${r.user_id}> (${LEAVE_TYPES[r.leave_type] || r.leave_type})`).join('، ').slice(0, 450) : 'لا أحد';
    lines.push(`**${kit.tsDate(date)}** ${kit.coverageBar(cov.count, cov.max)} • ${cov.count}/${cov.max}\n${people}`);
  }
  return embed(`🗓️ تقويم الإجازات — ${kit.tsDate(start)} → ${kit.tsDate(addDays(start, days - 1))}`, lines.join('\n\n').slice(0, 4000), COLORS.info)
    .setFooter({ text: 'التغطية محسوبة من الإجازات المعتمدة فقط • استخدم /request-leave لرؤية التوقع قبل الإرسال.' });
}

const reviewRow = (id) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`leave:approve:${id}`).setLabel('موافقة').setEmoji('✅').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`leave:reject:${id}`).setLabel('رفض').setEmoji('❌').setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId(`leave:details:${id}`).setLabel('تفاصيل').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
);

async function updateRequestMessage(client, row) {
  if (!row?.message_id) return false;
  try {
    const channel = await getChannel(client, 'leave-requests');
    const message = channel ? await channel.messages.fetch(row.message_id) : null;
    if (!message) return false;
    const color = STATUS_COLOR[row.status] || COLORS.gray;
    await message.edit({ content: null, embeds: [leaveEmbed(row, color)], components: row.status === 'pending' ? [reviewRow(row.id)] : [] });
    return true;
  } catch { return false; }
}

async function fetchMember(i, userId) {
  try { return i.guild?.members?.fetch ? await i.guild.members.fetch(userId) : null; } catch { return null; }
}

function myLeavesEmbed(userId, page = 1) {
  const { items, total, pages } = leaveService.list({ userId, perPage: 6, page });
  if (!total) return { embeds: [embed('🏖️ إجازاتي', 'لا توجد إجازات مسجلة.\n\nاستخدم **/request-leave** لطلب إجازة جديدة — ستظهر التغطية والحدود قبل الإرسال.', COLORS.gray)], components: [] };
  const e = embed('🏖️ إجازاتي', null, COLORS.info);
  for (const r of items) {
    const rule = LEAVE_RULES[r.leave_type] || {};
    const status = STATUS_AR[r.status] || r.status;
    const dur = r.duration_days ? `${r.duration_days} يوم` : `${r.start_date}→${r.end_date}`;
    e.addFields({ name: `${rule.emoji || '🏖️'} #${r.id} — ${status} • ${dur}`, value: `${LEAVE_TYPES[r.leave_type] || r.leave_type} • ${kit.tsDate(r.start_date)} → ${kit.tsDate(r.end_date)}${r.review_reason ? `\n↳ ${r.review_reason}` : ''}` });
  }
  e.setFooter({ text: `صفحة ${page}/${pages} • ${total} طلب • الألوان: ⏳ معلق ✅ معتمد ❌ مرفوض` });
  const nav = pages > 1 ? [kit.navRow({ prefix: 'leave:myleaves', page, pages, args: [userId] })] : [];
  // أزرار إجراءات سريعة للصفحة الحالية
  const actionable = items.filter(r => ['pending', 'approved'].includes(r.status) && r.start_date > today());
  if (actionable.length) {
    const menu = new StringSelectMenuBuilder().setCustomId(`leave:pickaction:${page}`).setPlaceholder('⚡ إجراء سريع على أحد طلبات هذه الصفحة...')
      .addOptions(actionable.slice(0, 10).map(r => ({
        label: `#${r.id} — ${r.status === 'pending' ? 'إلغاء' : 'تمديد'} • ${LEAVE_TYPES[r.leave_type]} ${r.start_date}→${r.end_date}`,
        value: `${r.id}:${r.status}`,
        description: r.status === 'pending' ? 'إلغاء الطلب فوراً' : 'تمديد النهاية',
        emoji: r.status === 'pending' ? '🚫' : '↗️',
      })));
    nav.push(new ActionRowBuilder().addComponents(menu));
  }
  return { embeds: [e], components: nav };
}

function pendingEmbed(page = 1) {
  const { items, total, pages } = leaveService.list({ status: 'pending', perPage: 4, page });
  if (!total) return { embeds: [embed('✅ لا توجد طلبات معلقة', 'كل طلبات الإجازة تمت مراجعتها.', COLORS.success)], components: [] };
  const e = embed(`⏳ طلبات الإجازة المعلّقة — صفحة ${page}/${pages}`, `العدد: **${total}** — الأقدم أولاً. كل بطاقة تحتوي زر **موافقة/رفض/تفاصيل**.`, COLORS.warning);
  return { embeds: [e], total, pages, items };
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('request-leave').setDescription('طلب إجازة — مع فحص التغطية والحدود')
        .addStringOption(o => o.setName('type').setDescription('نوع الإجازة').setRequired(true)
          .addChoices(...Object.entries(LEAVE_TYPES).map(([v, n]) => ({ name: `${LEAVE_RULES[v]?.emoji || '🏖️'} ${n} — حتى ${LEAVE_RULES[v]?.maxDays} يوم`, value: v })))),
      level: LEVELS.STAFF,
      async execute(i) {
        const pending = getDb().prepare(`SELECT id FROM leave_requests WHERE user_id = ? AND status = 'pending'`).get(i.user.id);
        if (pending) return replyEphemeral(i, `❌ لديك طلب معلّق بالفعل (#${pending.id}).\nألغِه أولاً أو انتظر القرار — استخدم **/my-leaves** للإدارة.`, COLORS.danger);
        const type = i.options.getString('type');
        const rule = settings.leavePolicy(type);
        const m = new ModalBuilder().setCustomId(`leave:modal:${type}`).setTitle(`${rule.emoji || '🏖️'} طلب إجازة — ${LEAVE_TYPES[type]}`);
        m.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('السبب (إجباري)').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('start').setLabel('البداية YYYY-MM-DD').setStyle(TextInputStyle.Short).setMaxLength(10).setRequired(true).setPlaceholder(today())),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('end').setLabel('النهاية YYYY-MM-DD').setStyle(TextInputStyle.Short).setMaxLength(10).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('attachment').setLabel('رابط مرفق (اختياري)').setStyle(TextInputStyle.Short).setMaxLength(400).setRequired(false)),
        );
        return i.showModal(m);
      },
    },
    {
      data: new SlashCommandBuilder().setName('my-leaves').setDescription('عرض إجازاتي مع إجراءات سريعة')
        .addIntegerOption(o => o.setName('page').setDescription('الصفحة').setRequired(false)),
      level: LEVELS.STAFF,
      async execute(i) {
        const page = i.options.getInteger('page') || 1;
        return i.reply({ ...myLeavesEmbed(i.user.id, page), ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('leave-history').setDescription('سجل إجازات إداري (للإدارة)')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('status').setDescription('تصفية بالحالة').setRequired(false)
          .addChoices(...Object.entries(STATUS_AR).map(([v, n]) => ({ name: n, value: v })))),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const user = i.options.getUser('user');
        const status = i.options.getString('status');
        const { items, total } = leaveService.list({ userId: user.id, status, perPage: 10, page: 1 });
        if (!total) return replyEphemeral(i, `لا توجد إجازات لـ <@${user.id}>${status ? ` بحالة ${STATUS_AR[status]}` : ''}.`, COLORS.gray);
        const e = embed(`🏖️ سجل إجازات <@${user.id}>`, items.map(r => {
          const rule = LEAVE_RULES[r.leave_type] || {};
          return `${rule.emoji || '🏖️'} \`#${r.id}\` ${STATUS_AR[r.status]} • ${LEAVE_TYPES[r.leave_type]} • ${kit.tsDate(r.start_date)} → ${kit.tsDate(r.end_date)}${r.reviewed_by ? ` • <@${r.reviewed_by}>` : ''}`;
        }).join('\n'), COLORS.info)
          .setFooter({ text: `${total} طلب • استخدم /leave-dashboard للمزيد` });
        return i.reply({ embeds: [e], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('leave-dashboard').setDescription('لوحة الإجازات — مراجعة وتصفية وتغطية')
        .addStringOption(o => o.setName('status').setDescription('الحالة').setRequired(false)
          .addChoices(...Object.entries(STATUS_AR).map(([v, n]) => ({ name: n, value: v })), { name: 'الكل', value: 'all' }))
        .addStringOption(o => o.setName('type').setDescription('النوع').setRequired(false)
          .addChoices(...Object.entries(LEAVE_TYPES).map(([v, n]) => ({ name: n, value: v })))),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const status = i.options.getString('status');
        const type = i.options.getString('type');
        const st = status === 'all' ? null : status;
        let query = 'SELECT * FROM leave_requests WHERE 1=1';
        const params = [];
        if (st) { query += ' AND status = ?'; params.push(st); }
        if (type) { query += ' AND leave_type = ?'; params.push(type); }
        query += ' ORDER BY CASE status WHEN \'pending\' THEN 0 WHEN \'approved\' THEN 1 ELSE 2 END, start_date DESC LIMIT 25';
        const rows = getDb().prepare(query).all(...params);
        if (!rows.length) return replyEphemeral(i, 'لا توجد نتائج بهذه التصفية.', COLORS.gray);

        const covToday = leaveService.coverageFor(today());
        const header = embed('🏖️ لوحة الإجازات', [
          `**اليوم:** ${kit.coverageBar(covToday.count, covToday.max)} مجازين`,
          st || type ? `**التصفية:** ${st ? STATUS_AR[st] : 'الكل'}${type ? ` • ${LEAVE_TYPES[type]}` : ''}` : '_بدون تصفية — أحدث 25 طلب_',
          '',
        ].join('\n'), COLORS.info);

        await i.reply({ embeds: [header], ephemeral: true });
        for (const r of rows.slice(0, 6)) {
          const components = r.status === 'pending' ? [reviewRow(r.id)] : [];
          await i.followUp({ embeds: [leaveEmbed(r)], components, ephemeral: true });
        }
        if (rows.length > 6) await i.followUp({ content: `_… و **${rows.length - 6}** طلب إضافي — استخدم **/review-leaves** للمعلقة فقط._`, ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('review-leaves').setDescription('مراجعة طلبات الإجازة المعلّقة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const { total, pages } = leaveService.list({ status: 'pending', perPage: 4, page: 1 });
        if (!total) return replyEphemeral(i, '✅ لا توجد طلبات إجازة معلّقة.', COLORS.success);
        const header = pendingEmbed(1);
        await i.reply({ embeds: header.embeds, ephemeral: true });
        for (const r of header.items) {
          const cov = leaveService.coverageBetween(r.start_date, r.end_date);
          const covText = cov.peak >= cov.max ? `⚠️ ممتلئة ${kit.coverageBar(cov.peak, cov.max)}` : `${kit.coverageBar(cov.peak, cov.max)}`;
          const e = leaveEmbed(r);
          e.addFields({ name: '👥 التغطية', value: covText, inline: true });
          // زر إلغاء سريع للمعلق
          const row = reviewRow(r.id);
          row.addComponents(new ButtonBuilder().setCustomId(`leave:cancelquick:${r.id}`).setLabel('إلغاء الطلب').setEmoji('🚫').setStyle(ButtonStyle.Secondary));
          await i.followUp({ embeds: [e], components: [row], ephemeral: true });
        }
        if (pages > 1) {
          await i.followUp({ components: [kit.navRow({ prefix: 'leave:pending', page: 1, pages })], ephemeral: true });
        }
      },
    },
    {
      data: new SlashCommandBuilder().setName('cancel-leave').setDescription('إلغاء طلب إجازة لم يبدأ بعد')
        .addIntegerOption(o => o.setName('id').setDescription('رقم الطلب').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('سبب الإلغاء').setRequired(false).setMaxLength(300)),
      level: LEVELS.STAFF,
      async execute(i) {
        const id = i.options.getInteger('id');
        const reason = i.options.getString('reason') || 'ألغاه صاحب الطلب';
        const db = getDb();
        const r = db.prepare("SELECT * FROM leave_requests WHERE id = ? AND user_id = ? AND status IN ('pending', 'approved')").get(id, i.user.id);
        if (!r) return replyEphemeral(i, '❌ الطلب غير موجود أو لا يمكن إلغاؤه (قد يكون منتهياً/ملغياً).', COLORS.danger);
        if (r.status === 'approved' && r.start_date <= today()) return replyEphemeral(i, '❌ بدأت الإجازة بالفعل. اطلب من الإدارة استخدام `/end-leave`.', COLORS.danger);
        db.prepare(`UPDATE leave_requests SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now'), cancel_reason = ?, end_reason = 'admin' WHERE id = ?`).run(i.user.id, reason, r.id);
        const member = await fetchMember(i, i.user.id);
        if (member) await leaveService.syncVacationRole(member);
        const updated = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id);
        await updateRequestMessage(i.client, updated);
        audit.record({ action: 'leave_cancelled', actorId: i.user.id, targetId: i.user.id, details: { requestId: r.id, reason }, channelId: i.channelId });
        return replyEphemeral(i, `✅ تم إلغاء طلب الإجازة **#${r.id}**.`, COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('extend-leave').setDescription('تمديد إجازة قائمة')
        .addIntegerOption(o => o.setName('id').setDescription('رقم الطلب').setRequired(true))
        .addStringOption(o => o.setName('new_end').setDescription('تاريخ النهاية الجديد YYYY-MM-DD').setRequired(true)),
      level: LEVELS.STAFF,
      async execute(i) {
        const id = i.options.getInteger('id');
        const newEnd = i.options.getString('new_end');
        const result = leaveService.extendRequest({ id, userId: i.user.id, newEnd, actorId: i.user.id });
        if (!result.ok) return replyEphemeral(i, `❌ ${result.message}${result.hint ? `\n💡 ${result.hint}` : ''}`, COLORS.danger);
        const updated = result.row;
        await updateRequestMessage(i.client, updated);
        // إن كانت معتمدة ونشطة، مزامنة الرتبة
        const member = await fetchMember(i, i.user.id);
        if (member && updated.status === 'approved') await leaveService.syncVacationRole(member);
        return replyEphemeral(i, `✅ تم تمديد الإجازة **#${id}** إلى **${newEnd}**.`, COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('end-leave').setDescription('إنهاء إجازة نشطة مبكراً (للإدارة)')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('سبب الإنهاء').setRequired(true).setMaxLength(300)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const user = i.options.getUser('user');
        const reason = i.options.getString('reason');
        const r = leaveService.activeForUser(user.id)[0];
        if (!r) return replyEphemeral(i, '❌ لا توجد إجازة نشطة لهذا الإداري.', COLORS.danger);
        const db = getDb();
        db.prepare(`UPDATE leave_requests SET status = 'ended', reviewed_by = ?, review_reason = ?, reviewed_at = datetime('now'), end_reason = 'early' WHERE id = ?`).run(i.user.id, reason, r.id);
        const member = await fetchMember(i, user.id);
        if (member) {
          await leaveService.syncVacationRole(member);
          if (!leaveService.approvedForUser(user.id).length) db.prepare("UPDATE leave_requests SET role_removed_at = COALESCE(role_removed_at, datetime('now')) WHERE id = ?").run(r.id);
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
    {
      data: new SlashCommandBuilder().setName('leave-calendar').setDescription('تقويم الإجازات والتغطية للأيام القادمة')
        .addStringOption(o => o.setName('start').setDescription('بداية YYYY-MM-DD (افتراضي: اليوم)').setRequired(false))
        .addIntegerOption(o => o.setName('days').setDescription('عدد الأيام (1-14)').setMinValue(1).setMaxValue(14).setRequired(false)),
      level: LEVELS.STAFF,
      async execute(i) {
        const start = i.options.getString('start') || today();
        const days = i.options.getInteger('days') || 14;
        if (!isValidDate(start)) return replyEphemeral(i, '❌ صيغة التاريخ غير صحيحة.', COLORS.danger);
        return i.reply({ embeds: [calendarEmbed(start, days)], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('leave-coverage').setDescription('عرض التغطية: من المجاز اليوم/في فترة')
        .addStringOption(o => o.setName('date').setDescription('تاريخ YYYY-MM-DD (افتراضي: اليوم)').setRequired(false))
        .addStringOption(o => o.setName('end').setDescription('إلى تاريخ YYYY-MM-DD لعرض نطاق').setRequired(false)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const date = i.options.getString('date') || today();
        const end = i.options.getString('end');
        if (!isValidDate(date) || (end && !isValidDate(end))) return replyEphemeral(i, '❌ صيغة التاريخ غير صحيحة.', COLORS.danger);
        if (end) {
          const cov = leaveService.coverageBetween(date, end);
          const rows = getDb().prepare(`SELECT user_id, leave_type, start_date, end_date FROM leave_requests WHERE status='approved' AND start_date <= ? AND end_date >= ?`).all(end, date);
          const e = embed(`👥 التغطية ${kit.tsDate(date)} → ${kit.tsDate(end)}`, [
            `**الذروة:** ${kit.coverageBar(cov.peak, cov.max)} في ${kit.tsDate(cov.peakDay)}`,
            rows.length ? rows.map(r => `• <@${r.user_id}> — ${LEAVE_TYPES[r.leave_type]} ${r.start_date}→${r.end_date}`).join('\n') : '_لا يوجد مجازون في هذه الفترة._',
          ].join('\n'), cov.peak >= cov.max ? COLORS.danger : COLORS.info);
          return i.reply({ embeds: [e], ephemeral: true });
        }
        const cov = leaveService.coverageFor(date);
        const e = embed(`👥 المجازون في ${kit.tsDate(date)}`, cov.rows.length ? cov.rows.map(r => `• <@${r.user_id}> — ${LEAVE_TYPES[r.leave_type]} ${r.start_date}→${r.end_date}`).join('\n') : '_لا يوجد مجازون._', cov.count >= cov.max ? COLORS.warning : COLORS.info)
          .addFields({ name: 'التغطية', value: kit.coverageBar(cov.count, cov.max) });
        return i.reply({ embeds: [e], ephemeral: true });
      },
    },
  ],

  components: {
    'leave:modal': async (i, [type]) => {
      const reason = i.fields.getTextInputValue('reason').trim();
      const start = i.fields.getTextInputValue('start').trim();
      const end = i.fields.getTextInputValue('end').trim();
      const attachment = (i.fields.getTextInputValue('attachment') || '').trim() || null;
      if (attachment && !/^https?:\/\/.+/i.test(attachment)) return replyEphemeral(i, '❌ رابط المرفق غير صحيح — يجب أن يبدأ بـ https://', COLORS.danger);

      const result = leaveService.createRequest({ userId: i.user.id, leaveType: type, reason, start, end, attachmentUrl: attachment });
      if (!result.ok) return replyEphemeral(i, `❌ ${result.message}${result.hint ? `\n💡 ${result.hint}` : ''}`, COLORS.danger);

      const r = result.row;
      const cov = leaveService.coverageBetween(start, end);
      const warn = cov.peak >= settings.leavePolicy().maxConcurrent ? `\n⚠️ **تنبيه:** الفترة ممتلئة (${kit.coverageBar(cov.peak, cov.max)}) — قد يُرفض الطلب.` : '';
      const msg = await sendToChannel(i.client, 'leave-requests', { content: warn || undefined, embeds: [leaveEmbed(r)], components: [reviewRow(r.id)] });
      if (msg) getDb().prepare('UPDATE leave_requests SET message_id = ? WHERE id = ?').run(msg.id, r.id);
      audit.record({ action: 'leave_requested', actorId: i.user.id, targetId: i.user.id, details: { requestId: r.id, type, start, end }, channelId: i.channelId });
      const summary = embed('✅ تم إرسال طلبك', [
        `**#${r.id}** — ${LEAVE_TYPES[type]} • ${kit.tsDate(start)} → ${kit.tsDate(end)} • **${r.duration_days}** يوم`,
        `الحالة: **${STATUS_AR[r.status]}** — سيصلك القرار في الخاص.`,
        covText(cov),
      ].join('\n'), COLORS.success);
      return replyEphemeral(i, summary, COLORS.success);
    },

    'leave:approve': async (i, [id]) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك صلاحية الموافقة.', COLORS.danger);
      const db = getDb();
      const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(id));
      if (!r || r.status !== 'pending') return replyEphemeral(i, '❌ الطلب غير موجود أو تمت مراجعته.', COLORS.danger);
      const vr = leaveService.validate({ userId: r.user_id, leaveType: r.leave_type, start: r.start_date, end: r.end_date, excludeId: r.id, atApproval: true });
      if (!vr.ok) return replyEphemeral(i, `❌ لا يمكن الموافقة: ${vr.message}${vr.hint ? `\n💡 ${vr.hint}` : ''}`, COLORS.danger);
      db.prepare(`UPDATE leave_requests SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`).run(i.user.id, r.id);
      const member = await fetchMember(i, r.user_id);
      const timing = settings.leavePolicy().vacationRoleTiming || 'at_start';
      let roleResult = { ok: true, skipped: true };
      // فور الموافقة أو عند البداية حسب الإعداد
      if (timing === 'at_approval' || r.start_date <= today()) {
        roleResult = member ? await staffService.addVacationRole(member) : { ok: false, missing: true };
        if (roleResult.ok) db.prepare("UPDATE leave_requests SET role_applied_at = COALESCE(role_applied_at, datetime('now')), role_grant_at = ? WHERE id = ?").run(today(), r.id);
      }
      if (r.start_date <= today() && staffService.get(r.user_id)?.status !== 'resigned') staffService.setStatus(r.user_id, 'on_leave');
      audit.record({ action: 'leave_approved', actorId: i.user.id, targetId: r.user_id, details: { requestId: r.id, start: r.start_date, end: r.end_date, vacationRole: roleResult.ok }, channelId: i.channelId });
      const updated = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id);
      await i.update({ content: null, embeds: [leaveEmbed(updated, COLORS.success)], components: [] });
      const roleMsg = timing === 'at_start' && r.start_date > today() ? 'ستُفعّل رتبة **in vacation** تلقائياً عند بداية الإجازة.' : roleResult.ok ? 'تم تفعيل رتبة **in vacation**.' : '⚠️ لم أستطع تفعيل رتبة **in vacation** — راجع /setup.';
      await dm(i.client, r.user_id, { embeds: [embed('✅ تمت الموافقة على إجازتك', `من ${kit.tsDate(r.start_date)} إلى ${kit.tsDate(r.end_date)}\n${roleMsg}`, COLORS.success)] });
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
      // نحاول تحديث رسالة الأزرار إن كانت هي نفسها
      try { await i.update({ content: null, embeds: [leaveEmbed(updated, COLORS.danger)], components: [] }); } catch { await replyEphemeral(i, `تم رفض الطلب #${r.id}.`, COLORS.danger); }
      await dm(i.client, r.user_id, { embeds: [embed('❌ تم رفض طلب إجازتك', `**السبب:** ${reason}`, COLORS.danger)] });
      return log(i.client, '🏖️ رفض إجازة', `<@${r.user_id}> — #${r.id} بواسطة <@${i.user.id}>\n${reason}`, COLORS.danger);
    },

    'leave:details': async (i, [id]) => {
      const r = getDb().prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(id));
      if (!r) return replyEphemeral(i, '❌ الطلب غير موجود.', COLORS.danger);
      const e = leaveEmbed(r);
      e.addFields(coverageField(r.start_date, r.end_date));
      const gap = leaveService.minGapViolated(r.user_id, r.start_date, r.end_date, r.id);
      if (gap) e.addFields({ name: '⚠️ تداخل الراحة', value: `تحتاج ${gap.required} يوم راحة — لديك ${gap.gap}.` });
      return i.reply({ embeds: [e], ephemeral: true });
    },

    'leave:cancelquick': async (i, [id]) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك الصلاحية.', COLORS.danger);
      const r = getDb().prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(id));
      if (!r || r.status !== 'pending') return replyEphemeral(i, '❌ الطلب غير معلق.', COLORS.danger);
      getDb().prepare(`UPDATE leave_requests SET status='cancelled', cancelled_by=?, cancelled_at=datetime('now'), cancel_reason='ألغته الإدارة من لوحة المراجعة', end_reason='admin' WHERE id=?`).run(i.user.id, r.id);
      const updated = getDb().prepare('SELECT * FROM leave_requests WHERE id=?').get(r.id);
      await updateRequestMessage(i.client, updated);
      audit.record({ action: 'leave_cancelled_by_admin', actorId: i.user.id, targetId: r.user_id, details: { requestId: r.id }, channelId: i.channelId });
      await i.update({ embeds: [leaveEmbed(updated, COLORS.gray)], components: [] });
      await dm(i.client, r.user_id, { embeds: [embed('🚫 أُلغي طلب إجازتك', `ألغت الإدارة الطلب **#${r.id}**.`, COLORS.warning)] });
    },

    'leave:myleaves': async (i, [page, userId]) => {
      // userId للتحقق أن الصفحة تخص صاحبها أو الإدارة
      const target = userId || i.user.id;
      if (target !== i.user.id && i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك الصلاحية.', COLORS.danger);
      return i.update(myLeavesEmbed(target, Number(page)));
    },
    'leave:pickaction': async (i) => {
      const raw = i.values[0];
      const [id, status] = raw.split(':');
      if (status === 'pending') {
        // إلغاء مباشر مع تأكيد
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`leave:confirmcancel:${id}`).setLabel('تأكيد الإلغاء').setStyle(ButtonStyle.Danger).setEmoji('🚫'),
          new ButtonBuilder().setCustomId('leave:cancelpick').setLabel('إلغاء').setStyle(ButtonStyle.Secondary),
        );
        return i.reply({ embeds: [embed('⚠️ تأكيد الإلغاء', `هل تريد إلغاء الطلب **#${id}**؟`, COLORS.warning)], components: [row], ephemeral: true });
      } else {
        const m = new ModalBuilder().setCustomId(`leave:extendmodal:${id}`).setTitle(`↗️ تمديد الإجازة #${id}`);
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('new_end').setLabel('تاريخ النهاية الجديد YYYY-MM-DD').setStyle(TextInputStyle.Short).setMaxLength(10).setRequired(true)));
        return i.showModal(m);
      }
    },
    'leave:confirmcancel': async (i, [id]) => {
      const r = getDb().prepare("SELECT * FROM leave_requests WHERE id=? AND user_id=? AND status IN ('pending','approved')").get(Number(id), i.user.id);
      if (!r) return replyEphemeral(i, '❌ لا يمكن إلغاء هذا الطلب.', COLORS.danger);
      if (r.status === 'approved' && r.start_date <= today()) return replyEphemeral(i, '❌ بدأت الإجازة — اطلب من الإدارة إنهاءها.', COLORS.danger);
      getDb().prepare(`UPDATE leave_requests SET status='cancelled', cancelled_by=?, cancelled_at=datetime('now'), cancel_reason='ألغاه صاحب الطلب' WHERE id=?`).run(i.user.id, r.id);
      const member = await fetchMember(i, i.user.id);
      if (member) await leaveService.syncVacationRole(member);
      await updateRequestMessage(i.client, getDb().prepare('SELECT * FROM leave_requests WHERE id=?').get(r.id));
      await i.update({ embeds: [embed('✅ تم الإلغاء', `أُلغي الطلب **#${id}**.`, COLORS.success)], components: [] });
    },
    'leave:cancelpick': async (i) => i.update({ embeds: [embed(null, 'تم الإلغاء.', COLORS.gray)], components: [] }),
    'leave:extendmodal': async (i, [id]) => {
      const newEnd = i.fields.getTextInputValue('new_end').trim();
      const result = leaveService.extendRequest({ id: Number(id), userId: i.user.id, newEnd, actorId: i.user.id });
      if (!result.ok) return replyEphemeral(i, `❌ ${result.message}${result.hint ? `\n💡 ${result.hint}` : ''}`, COLORS.danger);
      await updateRequestMessage(i.client, result.row);
      return replyEphemeral(i, `✅ تم تمديد الطلب **#${id}** إلى **${newEnd}**.`, COLORS.success);
    },
    'leave:pending': async (i, [page]) => {
      const { items, total, pages } = leaveService.list({ status: 'pending', perPage: 4, page: Number(page) });
      if (!total) return i.update({ embeds: [embed('✅ لا توجد طلبات', 'انتهت المراجعة.', COLORS.success)], components: [] });
      // نعيد بناء الصفحة
      await i.update({ embeds: [embed(`⏳ طلبات معلقة — صفحة ${page}/${pages}`, `العدد: **${total}**`, COLORS.warning)], components: [kit.navRow({ prefix: 'leave:pending', page: Number(page), pages })] });
      for (const r of items) {
        await i.followUp({ embeds: [leaveEmbed(r).addFields(coverageField(r.start_date, r.end_date))], components: [reviewRow(r.id)], ephemeral: true });
      }
    },
  },
};

function covText(cov) {
  if (cov.peak >= cov.max) return `⚠️ **التغطية ممتلئة** ${kit.coverageBar(cov.peak, cov.max)} — قد يُرفض الطلب`;
  if (cov.peak >= cov.max - 1) return `🟡 **شبه ممتلئة** ${kit.coverageBar(cov.peak, cov.max)}`;
  return `✅ **التغطية متاحة** ${kit.coverageBar(cov.peak, cov.max)}`;
}
