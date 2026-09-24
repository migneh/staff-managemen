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
  // تكتات
  ticket_closed: { label: 'تكت مغلق', emoji: '🎫', key: 'ticket_closed' },
  ticket_rating_5: { label: 'تكت بتقييم 5', emoji: '⭐⭐⭐⭐⭐', key: 'ticket_rating_5' },
  ticket_rating_4: { label: 'تكت بتقييم 4', emoji: '⭐⭐⭐⭐', key: 'ticket_rating_4' },
  ticket_rating_low: { label: 'تكت بتقييم 1-2', emoji: '⭐', key: 'ticket_rating_low' },
  ticket_reopened: { label: 'تكت معاد فتحه', emoji: '🔄', key: 'ticket_reopened' },
  
  // مخالفات/إشراف
  mod_action: { label: 'مخالفة معالجة', emoji: '🛡️', key: 'mod_action' },
  fast_response: { label: 'استجابة سريعة < 5 د', emoji: '⚡', key: 'fast_response' },
  wrong_decision: { label: 'قرار خاطئ', emoji: '❌', key: 'wrong_decision' },
  
  // أسبوعي/شهري
  week_above_80: { label: 'أسبوع Score فوق 80', emoji: '📈', key: 'week_above_80' },
  week_below_50: { label: 'أسبوع Score تحت 50', emoji: '📉', key: 'week_below_50' },
  
  // تعاون/مساعدة
  helped_newbie: { label: 'مساعدة عضو جديد', emoji: '🤝', key: 'helped_newbie' },
  shoutout: { label: 'تقدير من زميل', emoji: '👏', key: 'shoutout' },
  complex_case: { label: 'حل تكت/حالة معقدة', emoji: '🔧', key: 'complex_case' },
  
  // ملاحظات
  positive_note: { label: 'ملاحظة إيجابية', emoji: '🟢', key: 'positive_note' },
  negative_note: { label: 'ملاحظة سلبية', emoji: '🟡', key: 'negative_note' },
  
  // إنذارات
  formal_warning: { label: 'إنذار رسمي', emoji: '🔴', key: 'formal_warning' },
  verbal_warning: { label: 'إنذار شفهي', emoji: '🟡', key: 'verbal_warning' },
  
  // مكافآت
  best_of_month: { label: 'أفضل إداري بالشهر', emoji: '🏆', key: 'best_of_month' },
  retention_3m: { label: 'استمرارية 3 أشهر', emoji: '📅', key: 'retention_3m' },
  retention_6m: { label: 'استمرارية 6 أشهر', emoji: '📅📅', key: 'retention_6m' },
  retention_12m: { label: 'استمرارية 12 شهر', emoji: '📅📅📅', key: 'retention_12m' },
  
  // خصومات
  absence: { label: 'غياب بدون إجازة', emoji: '🚫', key: 'absence' },
  spam: { label: 'سبام', emoji: '📨📨📨', key: 'spam' },
  long_leave_15_21: { label: 'إجازة طويلة 15-21 يوم', emoji: '🏖️📅', key: 'long_leave_15_21' },
  long_leave_22_28: { label: 'إجازة طويلة 22-28 يوم', emoji: '🏖️📅📅', key: 'long_leave_22_28' },
  long_leave_29_30: { label: 'إجازة طويلة 29-30 يوم', emoji: '🏖️📅📅📅', key: 'long_leave_29_30' },
  
  // يدوي
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
  return e.setFooter({ text: `النقاط التلقائية مستمرة كما هي • تُخصم/تُضاف في الرتبة الحالية فقط • ${cat.label}` });
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
        .addIntegerOption(o => o.setName('points').setDescription('عدد النقاط (سالب = خصم)').setRequired(true).setMinValue(-1000).setMaxValue(1000))
        .addStringOption(o => o.setName('reason').setDescription('السبب — يظهر للعضو وفي السجل').setRequired(true).setMaxLength(500))
        .addStringOption(o => o.setName('category').setDescription('التصنيف').addChoices(
          { name: '🎫 تكت مغلق', value: 'ticket_closed' },
          { name: '⭐⭐⭐⭐⭐ تكت بتقييم 5', value: 'ticket_rating_5' },
          { name: '⭐⭐⭐⭐ تكت بتقييم 4', value: 'ticket_rating_4' },
          { name: '⭐ تكت بتقييم 1-2', value: 'ticket_rating_low' },
          { name: '🔄 تكت معاد فتحه', value: 'ticket_reopened' },
          { name: '🛡️ مخالفة معالجة', value: 'mod_action' },
          { name: '⚡ استجابة سريعة < 5 د', value: 'fast_response' },
          { name: '❌ قرار خاطئ', value: 'wrong_decision' },
          { name: '📈 أسبوع Score فوق 80', value: 'week_above_80' },
          { name: '📉 أسبوع Score تحت 50', value: 'week_below_50' },
          { name: '🤝 مساعدة عضو جديد', value: 'helped_newbie' },
          { name: '👏 تقدير من زميل', value: 'shoutout' },
          { name: '🔧 حل تكت/حالة معقدة', value: 'complex_case' },
          { name: '🟢 ملاحظة إيجابية', value: 'positive_note' },
          { name: '🟡 ملاحظة سلبية', value: 'negative_note' },
          { name: '🔴 إنذار رسمي', value: 'formal_warning' },
          { name: '🟡 إنذار شفهي', value: 'verbal_warning' },
          { name: '🏆 أفضل إداري بالشهر', value: 'best_of_month' },
          { name: '📅 استمرارية 3 أشهر', value: 'retention_3m' },
          { name: '📅📅 استمرارية 6 أشهر', value: 'retention_6m' },
          { name: '📅📅📅 استمرارية 12 شهر', value: 'retention_12m' },
          { name: '🚫 غياب بدون إجازة', value: 'absence' },
          { name: '📨📨📨 سبام', value: 'spam' },
          { name: '🏖️📅 إجازة طويلة 15-21 يوم', value: 'long_leave_15_21' },
          { name: '🏖️📅📅 إجازة طويلة 22-28 يوم', value: 'long_leave_22_28' },
          { name: '🏖️📅📅📅 إجازة طويلة 29-30 يوم', value: 'long_leave_29_30' },
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
      data: new SlashCommandBuilder().setName('points-overview').setDescription('نظرة سريعة على النقاط: رصيدك، ترتيبك، وآخر الحركات')
      .addBooleanOption(o => o.setName('detailed').setDescription('عرض تفصيلي أكثر (افتراضياً: مختصر)')),
      level: LEVELS.STAFF,
      async execute(i) {
        const detailed = i.options.getBoolean('detailed') || false;
        const rows = staffService.all().map(m => ({ ...m, total: points.total(m.user_id) }));
        const mine = rows.find(r => r.user_id === i.user.id);
        const rank = mine ? rows.slice().sort((a, b) => b.total - a.total).findIndex(r => r.user_id === i.user.id) + 1 : null;
        const recent = points.history(i.user.id, detailed ? 20 : 5);
        const e = kit.card({
          title: '🎯 نقاطك',
          description: detailed 
            ? '_يعرض السجل الكامل للنقاط مع إمكانية التصفية عبر `/points-history`._'
            : '_تُحتسب نقاط رتبتك الحالية فقط، ويبقى السجل الكامل متاحاً في `/points-history`._',
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
    {
      data: new SlashCommandBuilder().setName('points-history').setDescription('سجل النقاط المفصل مع خيارات التصفية')
      .addStringOption(o => o.setName('category').setDescription('تصفية حسب الفئة').addChoices(
        { name: 'جميع الفئات', value: 'all' },
        { name: '🎫 تكتات', value: 'ticket' },
        { name: '🛡️ مخالفات وإشراف', value: 'moderation' },
        { name: '📈 مكافآت أسبوعية/شهرية', value: 'bonus' },
        { name: '🤝 تعاون ومساعدة', value: 'help' },
        { name: '📝 ملاحظات', value: 'notes' },
        { name: '⚠️ إنذارات', value: 'warnings' },
        { name: '🚫 خصومات', value: 'penalties' },
        { name: '🌟 منح يدوية', value: 'manual' }
      ))
      .addIntegerOption(o => o.setName('days').setDescription('عدد الأيام للأرجاع (الافتراضي: 30)').setMinValue(1).setMaxValue(365))
      .addBooleanOption(o => o.setName('only-current-epoch').setDescription('عرض نقاط الرتبة الحالية فقط (افتراضياً: نعم)'))
      .addBooleanOption(o => o.setName('show-epochs').setDescription('عرض عصر النقاط لكل حركة')),
      level: LEVELS.STAFF,
      async execute(i) {
        const categoryFilter = i.options.getString('category') || 'all';
        const days = i.options.getInteger('days') || 30;
        const onlyCurrentEpoch = i.options.getBoolean('only-current-epoch') !== false;
        const showEpochs = i.options.getBoolean('show-epochs') || false;
        
        const userId = i.user.id;
        const since = days > 0 ? clock.addDays(clock.today(), -days) : undefined;
        
        const history = points.history(userId, 100, { allEpochs: !onlyCurrentEpoch });
        
        // Apply category filter
        let filteredHistory = history;
        if (categoryFilter !== 'all') {
          filteredHistory = history.filter(entry => {
            const catKey = entry.reason_key;
            switch(categoryFilter) {
              case 'ticket':
                return catKey.startsWith('ticket_');
              case 'moderation':
                return ['mod_action', 'fast_response', 'wrong_decision'].includes(catKey);
              case 'bonus':
                return ['week_above_80', 'week_below_50', 'best_of_month', 'retention_3m', 'retention_6m', 'retention_12m'].includes(catKey);
              case 'help':
                return ['helped_newbie', 'shoutout', 'complex_case'].includes(catKey);
              case 'notes':
                return ['positive_note', 'negative_note'].includes(catKey);
              case 'warnings':
                return ['formal_warning', 'verbal_warning'].includes(catKey);
              case 'penalties':
                return ['absence', 'spam', 'long_leave_15_21', 'long_leave_22_28', 'long_leave_29_30'].includes(catKey);
              case 'manual':
                return ['manual_boost', 'manually_helped', 'manual_correction', 'manual_violation'].includes(catKey);
              default:
                return true;
            }
          });
        }
        
        // Apply time filter
        if (since) {
          filteredHistory = filteredHistory.filter(entry => 
            entry.created_at >= since
          );
        }
        
        // Limit to most recent 50 entries
        const displayHistory = filteredHistory.slice(0, 50);
        
        const e = kit.card({
          title: '📊 سجل النقاط المفصل',
          description: `عرض آخر ${displayHistory.length} حركة${since ? ` من آخر ${days} يوم` : ''}${onlyCurrentEpoch ? '' , ' (كل العصور)'}${showEpochs ? '' , ' (بدون عرض العصور)'}`,
          fields: [
            { name: '💰 إجمالي النقاط', value: `${arDigits(points.total(userId, since, { allEpochs: !onlyCurrentEpoch }))}` },
            { name: '📅 الفترة', value: `${since ? `من ${clock.addDays(clock.today(), -days)} إلى ${clock.today()}` : 'الكل'}` },
            { name: '🔍 التصفية', value: categoryFilter === 'all' ? 'جميع الفئات' : categoryFilter },
          ]
        });
        
        if (displayHistory.length === 0) {
          e.addFields({ name: '📭 لا توجد نقاط', value: 'لا توجد نقاط تطابق معايير التصفية.' });
        } else {
          const historyText = displayHistory.map(entry => {
            const cat = CATEGORIES[entry.reason_key] || { label: entry.reason_key, emoji: '❓' };
            const epochInfo = showEpochs && entry.epoch ? ` [عصر ${entry.epoch}]` : '';
            return `${entry.points > 0 ? '🟢 +' : '🔴 '}${Math.abs(entry.points)} — ${cat.emoji} ${cat.label}${epochInfo}\n${truncate(entry.reason, 100)}\n${clock.tsRelative(entry.created_at)}`;
          }).join('\n\n');
          
          e.addFields({ name: '📜 سجل الحركات', value: kit.clip(historyText, 2000) });
        }
        
        e.addFields({
          name: 'ℹ️ ملاحظات',
          value: 'استخدم `/points-history` مع خيارات التصفية للعرض المخصص.\nالرموز: 🟢 نقاط مضافة • 🔴 نقاط خصومة'
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
              { name: '🎯 الفئة', value: `${cat.emoji} ${cat.label}`, inline: true },
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
