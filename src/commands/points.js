'use strict';
/**
 * منح النقاط يدوياً — مع بقاء النقاط التلقائية (التكتات والإجراءات والتقارير) كما هي.
 * القاعدة: لا تُكتب أي نقاط قبل تأكيد المراجع، وكل منحة تحمل مرجعاً فريداً فلا تتكرر بالنقر مرتين.
 */
const { randomBytes } = require('node:crypto');
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const points = require('../services/points');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { LEVELS, STATUS, POINTS } = require('../constants');
const kit = require('../ui/kit');
const { COLORS, replyEphemeral, dm, log, arDigits, truncate } = require('../utils');

const TTL = 10 * 60 * 1000;
const LIMIT = 200;
const drafts = new Map();

const CATEGORIES = {
  boost: { label: 'تحفيز وأداء متميز', emoji: '🌟', key: 'manual_boost' },
  help: { label: 'مساعدة زملاء أو أعضاء', emoji: '🤝', key: 'manually_helped' },
  correction: { label: 'تصحيح رصيد أو تعويض', emoji: '🧾', key: 'manual_correction' },
  violation: { label: 'مخالفة أو تقصير', emoji: '⚠️', key: 'manual_violation' },
};

function prune() {
  const now = Date.now();
  for (const [token, d] of drafts) if (d.expires <= now) drafts.delete(token);
}
function pick(token) {
  prune();
  const d = drafts.get(token);
  return d && d.expires > Date.now() ? d : null;
}
const sign = n => `${n > 0 ? '+' : ''}${arDigits(n)}`;

/** بطاقة التأكيد: كل ما يحتاجه المراجع قبل كتابة أي نقطة. */
function grantCard(d, { done = false, total = null } = {}) {
  const cat = CATEGORIES[d.category] || CATEGORIES.boost;
  const member = staffService.get(d.userId);
  const current = total ?? points.total(d.userId);
  const after = done && total != null ? total : current + d.amount;
  const recent = points.history(d.userId, 5).filter(r => r.counts);
  const fields = [
    { name: '👤 الإداري', value: `<@${d.userId}> — **${member?.rank || '—'}**`, inline: true },
    { name: '🎯 الفئة', value: `${cat.emoji} ${cat.label}`, inline: true },
    { name: '💯 التغيير', value: `**${sign(d.amount)}** نقطة`, inline: true },
    { name: '📈 الرصيد', value: done ? `بعد المنح: **${arDigits(after)}**` : `${arDigits(current)} ← **${arDigits(after)}**`, inline: true },
    { name: '📝 السبب', value: truncate(d.reason, 300), inline: false },
  ];
  if (member && ['suspended', 'resigned', 'removed'].includes(member.status)) {
    fields.push({ name: '⚠️ تنبيه', value: `حالة الإداري **${STATUS[member.status] || member.status}** — تأكد أن المنح مقصود.`, inline: false });
  }
  const e = kit.card({
    title: done ? '✅ تم منح النقاط' : '🎯 منح نقاط يدوي',
    description: done ? `بواسطة <@${d.actorId}> — نُشرت الحركة في سجل التعديلات.` : '_لن تُكتب النقاط حتى تضغط «تأكيد المنح»._',
    fields,
    color: done ? COLORS.success : COLORS.info,
    footer: kit.footerLine(done ? `🎯 حركة يدوية • ${sign(d.amount)} نقطة` : '🎯 مراجعة قبل الكتابة — لا تغيير في قاعدة البيانات'),
  });
  if (recent.length) {
    e.addFields({
      name: 'آخر الحركات',
      value: kit.clip(recent.map(r => `• ${sign(r.points)} — ${r.reason || r.reason_key}${r.counts ? '' : ' _(رتبة سابقة)_'}`).join('\n'), 1024),
    });
  }
  return e.setFooter({ text: `النقاط التلقائية مستمرة كما هي • تُخصم/تُضاف في الرتبة الحالية فقط • ${POINTS[CATEGORIES[d.category]?.key]?.label || 'إضافة يدوية'}` });
}

function grantRow(token, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`points:grantok:${token}`).setLabel('تأكيد المنح').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`points:grantcancel:${token}`).setLabel('إلغاء').setEmoji('✖️').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('give-points').setDescription('منح أو خصم نقاط لإداري يدوياً — مع تأكيد قبل الكتابة')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addIntegerOption(o => o.setName('points').setDescription('عدد النقاط (سالب = خصم)').setRequired(true).setMinValue(-500).setMaxValue(500))
        .addStringOption(o => o.setName('reason').setDescription('السبب — يظهر للعضو وفي السجل').setRequired(true).setMaxLength(200))
        .addStringOption(o => o.setName('category').setDescription('التصنيف').addChoices(
          { name: '🌟 تحفيز وأداء متميز', value: 'boost' },
          { name: '🤝 مساعدة زملاء أو أعضاء', value: 'help' },
          { name: '🧾 تصحيح رصيد أو تعويض', value: 'correction' },
          { name: '⚠️ مخالفة أو تقصير', value: 'violation' },
        ))
        .addBooleanOption(o => o.setName('notify').setDescription('إبلاغ العضو في الخاص (افتراضياً: نعم)')),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const user = i.options.getUser('user');
        const amount = i.options.getInteger('points');
        const reason = i.options.getString('reason').trim();
        const category = i.options.getString('category') || (amount < 0 ? 'violation' : 'boost');
        const member = staffService.get(user.id);
        if (!member) return replyEphemeral(i, `❌ <@${user.id}> غير مسجّل كإداري. استخدم **/sync-staff** لتسجيل الإداريين دفعة واحدة.`, COLORS.danger);
        if (!amount) return replyEphemeral(i, '❌ عدد النقاط لا يمكن أن يكون صفراً.', COLORS.danger);

        prune();
        if (drafts.size >= LIMIT) {
          const oldest = drafts.keys().next().value;
          drafts.delete(oldest);
        }
        const token = randomBytes(6).toString('hex');
        const draft = { token, actorId: i.user.id, userId: user.id, amount, reason, category, notify: i.options.getBoolean('notify') !== false, channelId: i.channelId, client: i.client, expires: Date.now() + TTL };
        drafts.set(token, draft);
        return i.reply({ embeds: [grantCard(draft)], components: [grantRow(token)], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('points-overview').setDescription('نظرة سريعة على النقاط: رصيدك، ترتيبك، وآخر الحركات'),
      level: LEVELS.STAFF,
      async execute(i) {
        const rows = staffService.all().map(m => ({ ...m, total: points.total(m.user_id) }));
        const mine = rows.find(r => r.user_id === i.user.id);
        const rank = mine ? rows.slice().sort((a, b) => b.total - a.total).findIndex(r => r.user_id === i.user.id) + 1 : null;
        const recent = points.history(i.user.id, 5);
        const e = kit.card({
          title: '🎯 نقاطك',
          description: '_تُحتسب نقاط رتبتك الحالية فقط، ويبقى السجل الكامل متاحاً في `/points-history`._',
          fields: [
            { name: '💯 الرصيد', value: `${arDigits(mine?.total ?? 0)} نقطة`, inline: true },
            rank ? { name: '🏅 الترتيب', value: `${arDigits(rank)} من ${arDigits(rows.length)}`, inline: true } : null,
            recent.length ? { name: '🧾 آخر الحركات', value: kit.clip(recent.map(r => `• ${sign(r.points)} — ${r.reason || r.reason_key}${r.counts ? '' : ' _(رتبة سابقة)_'}`).join('\n'), 1024), inline: false } : null,
            { name: '⬆️ كيف تزيد نقاطك؟', value: 'التكتات المغلقة والتقييمات العالية والإجراءات المسجّلة تُضاف تلقائياً. الإدارة يمكنها أيضاً منح نقاط يدوية بسبب موثّق.', inline: false },
          ],
          color: COLORS.info,
          footer: kit.footerLine('🎯 ملخّص شخصي'),
        });
        return i.reply({ embeds: [e], ephemeral: true });
      },
    },
  ],

  components: {
    'points:grantok': async (i, [token]) => {
      const d = pick(token);
      if (!d) return replyEphemeral(i, '⌛ انتهت صلاحية هذه المنحة. أعد تنفيذ **/give-points** لمراجعة الأرقام من جديد.', COLORS.warning);
      if (d.actorId !== i.user.id) return replyEphemeral(i, '❌ هذه المنحة تخص مراجعاً آخر. استخدم الأمر بنفسك.', COLORS.danger);
      drafts.delete(token);
      const cat = CATEGORIES[d.category] || CATEGORIES.boost;
      const earned = points.add(d.userId, cat.key, staffService.get(d.userId)?.team, {
        reason: d.reason, refType: 'manual', refId: token, addedBy: d.actorId, override: d.amount,
      });
      if (!earned) return replyEphemeral(i, 'ℹ️ لم تُكتب النقاط (قيمة صفرية أو حركة مكررة). لم يتغيّر الرصيد.', COLORS.info);
      const total = points.total(d.userId);
      audit.record({
        action: 'points_granted', actorId: d.actorId, targetId: d.userId,
        details: { amount: earned, reason: d.reason, category: d.category, total, manual: true }, channelId: i.channelId,
      });
      if (d.notify !== false) {
        await dm(d.client, d.userId, {
          embeds: [kit.card({
            title: earned > 0 ? '🎉 أُضيفت لك نقاط' : '⚠️ خُصمت منك نقاط',
            description: `يمكنك الاعتراض على أي حركة من \`/points-history\` ← «اعتراض».`,
            fields: [
              { name: '💯 التغيير', value: `**${sign(earned)}** نقطة`, inline: true },
              { name: '📈 رصيدك الآن', value: `**${arDigits(total)}** نقطة`, inline: true },
              { name: '🎯 الفئة', value: cat.label, inline: true },
              { name: '📝 السبب', value: truncate(d.reason, 500), inline: false },
            ],
            color: earned > 0 ? COLORS.success : COLORS.danger,
            footer: kit.footerLine(`بواسطة <@${d.actorId}>`),
          })],
        });
      }
      const card = grantCard(d, { done: true, total });
      try { await i.update({ embeds: [card], components: [grantRow(token, true)] }); } catch { await replyEphemeral(i, card, COLORS.success); }
      return log(i.client, earned > 0 ? '🎯 منح نقاط يدوي' : '⚠️ خصم نقاط يدوي',
        `<@${d.userId}> — **${sign(earned)}** نقطة (${cat.label})\n**السبب:** ${d.reason}\nبواسطة <@${d.actorId}> • الرصيد: **${total}**`,
        earned > 0 ? COLORS.success : COLORS.danger);
    },

    'points:grantcancel': async (i, [token]) => {
      const d = pick(token);
      if (d && d.actorId === i.user.id) drafts.delete(token);
      return i.update({ embeds: [kit.notice('neutral', 'أُلغيت المنحة', 'لم تُكتب أي نقاط ولم يتغيّر الرصيد. يمكنك تنفيذ الأمر من جديد عند الحاجة.', { footer: kit.footerLine('🎯 منحة ملغاة') })], components: [] });
    },
  },
};
