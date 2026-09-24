'use strict';
const forms = require('../ui/forms');
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder } = require('discord.js');
const { LEVELS, WARNING_TYPES, NOTE_TYPES, POINTS, COOLDOWNS, STATUS } = require('../constants');
const { getDb } = require('../database');
const points = require('../services/points');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { COLORS, replyEphemeral, sendToChannel, dm, log } = require('../utils');
const kit = require('../ui/kit');

const ID_RE = /^\d{15,22}$/;
const DRAFT_TTL = 15 * 60 * 1000;
const drafts = new Map();

function rememberDraft(draft) { drafts.set(draft.token, draft); }
function getDraft(i, token) {
  const d = drafts.get(token);
  if (!d || d.owner !== i.user.id || d.guild !== i.guildId || d.expires <= Date.now()) return null;
  return d;
}

/** بطاقة التحذير: خطوات واضحة وتأكيد قبل الكتابة */
function warningCard(draft, { pending = false, rowId = null, earned = null } = {}) {
  const def = WARNING_TYPES[draft.type];
  return kit.card({
    title: pending ? `⚠️ تأكيد تسجيل: ${def.label}` : `✅ سُجّل إنذار: ${def.label}`,
    description: pending
      ? '_لن يُكتب أي شيء في السجل حتى تضغط «تأكيد التسجيل»._'
      : `بواسطة <@${draft.actorId}> — السجل **#${rowId}**.`,
    fields: [
      { name: '👤 العضو', value: `<@${draft.target}>`, inline: true },
      { name: '📋 السبب', value: draft.reason, inline: false },
      { name: '💠 النقاط', value: pending ? `متوقعة **${earned}**` : `**${earned}**`, inline: true },
      pending ? { name: 'ℹ️ ملاحظة', value: 'تُخصم النقاط تلقائياً عند التأكيد، وتستمر بقية النقاط التلقائية.', inline: false } : null,
    ],
    color: pending ? COLORS.info : COLORS.warning,
    footer: kit.footerLine(pending ? '⚠️ مراجعة قبل التسجيل' : `السجل #${rowId}`),
  });
}

function warningButtons(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`punish:warningok:${token}`).setLabel('تأكيد التسجيل').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`punish:warnedit:${token}`).setLabel('تعديل').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`punish:warningcancel:${token}`).setLabel('إلغاء').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  );
}

/** بطاقة الملاحظة: خطوات واضحة وتأكيد قبل الكتابة */
function noteCard(draft, { pending = false, rowId = null, earned = null } = {}) {
  const def = NOTE_TYPES[draft.type];
  return kit.card({
    title: pending ? `📝 تأكيد تسجيل: ${def.label}` : `✅ سُجّلت ملاحظة: ${def.label}`,
    description: pending
      ? '_لن يُكتب أي شيء في السجل حتى تضغط «تأكيد التسجيل»._'
      : `بواسطة <@${draft.actorId}> — السجل **#${rowId}**.`,
    fields: [
      { name: '👤 العضو', value: `<@${draft.target}>`, inline: true },
      { name: '📝 المحتوى', value: draft.content, inline: false },
      { name: '💠 النقاط', value: pending ? `متوقعة **${earned}**` : `**${earned}**`, inline: true },
      draft.is_secret ? { name: '🔒 سرية', value: 'نعم', inline: true } : null,
      pending ? { name: 'ℹ️ ملاحظة', value: 'تُضاف النقاط تلقائياً عند التأكيد، وتستمر بقية النقاط التلقائية.', inline: false } : null,
    ],
    color: pending ? COLORS.info : (draft.type === 'positive' ? COLORS.success : COLORS.warning),
    footer: kit.footerLine(pending ? '📝 مراجعة قبل التسجيل' : `السجل #${rowId}`),
  });
}

function noteButtons(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`punish:notekok:${token}`).setLabel('تأكيد التسجيل').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`punish:noteedit:${token}`).setLabel('تعديل').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`punish:notecancel:${token}`).setLabel('إلغاء').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  );
}

const modals = {
  warning: ({ type = 'first' } = {}) => ({
    id: `punish:warning:${type}`,
    title: `⚠️ تسجيل إنذار: ${WARNING_TYPES[type].label}`,
    fields: [
      forms.user({ id: 'target', label: 'العضو الذي يخصه الإنذار', description: 'ابحث بالاسم واختر العضو الصحيح قبل الإرسال.' }),
      forms.select({ id: 'preset', label: 'أسباب جاهزة', required: false, multiple: true,
        options: [
          { label: 'إساءة للأعضاء', value: 'إساءة للأعضاء' },
          { label: 'تجاهل الأنظمة', value: 'تجاهل أنظمة السيرفر' },
          { label: 'نقاش غير صحي', value: 'إثارة نقاش غير صحي' },
          { label: 'مخالفة القوانين', value: 'مخالفة قوانين السيرفر' },
          { label: 'سلوك غير لائق', value: 'سلوك غير لائق' },
        ],
        description: 'اختر ما ينطبق، أو اكتب السبب بنفسك في الحقل التالي.' }),
      forms.field({ id: 'reason', label: 'تفاصيل السبب', required: false, style: 'paragraph', max: 500,
        description: 'تُلحق بالأسباب المختارة وتظهر في سجل الإجراءات وإشعار الإدارة.' }),
    ],
    note: 'يظهر النص للعضو في الخاص ويُسجَّل مع فترة التبريد في سجل التدقيق.',
  }),
  note: ({ type = 'positive' } = {}) => ({
    id: `punish:note:${type}`,
    title: `📝 تسجيل ملاحظة: ${NOTE_TYPES[type].label}`,
    fields: [
      forms.user({ id: 'target', label: 'العضو الذي يخصه الملاحظة', description: 'ابحث بالاسم واختر العضو الصحيح قبل الإرسال.' }),
      forms.field({ id: 'content', label: 'نص الملاحظة', required: true, style: 'paragraph', max: 500,
        description: 'اكتب الملاحظة التي سيشاهدها العضو (إلا إذا كانت سرية).' }),
      forms.select({ id: 'secret', label: 'نوع الملاحظة', required: true,
        options: [
          { label: 'عادية - يراه العضو', value: 'false' },
          { label: 'سرية - للإدارة فقط', value: 'true' },
        ],
        description: 'اختر ما إذا كانت الملاحظة سرية (مرئية للإدارة فقط) أو عادية (مرئية للجميع).' }),
    ],
    note: 'الملاحظات الإيجابية تضيف نقاطاً، والسلبية تخصم نقاطاً.',
  }),
};

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('warn').setDescription('إصدار إنذار على إداري')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('type').setDescription('نوع الإنذار').setRequired(true)
          .addChoices(
            { name: '🟡 إنذار شفهي (-10 نقطة)', value: 'verbal' },
            { name: '🟠 إنذار أول (-20 نقطة)', value: 'first' },
            { name: '🔴 إنذار ثاني (-20 نقطة)', value: 'second' },
            { name: '🔴 إنذار أخير (-20 نقطة + إيقاف)', value: 'final' }
          )),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        const user = i.options.getUser('user');
        const type = i.options.getString('type');
        const target = staffService.get(user.id);
        if (!target) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        if (user.id === i.user.id) return replyEphemeral(i, '❌ لا يمكنك إنذار نفسك.', COLORS.danger);
        
        const def = WARNING_TYPES[type];
        if (i.staffLevel < def.minLevel) return replyEphemeral(i, `❌ ${def.label} يتطلب صلاحية أعلى.`, COLORS.danger);
        
        return forms.open(i, { ...modals.warning({ type }), title: `⚠️ تسجيل إنذار: ${def.label}` });
      },
    },
    {
      data: new SlashCommandBuilder().setName('note').setDescription('إضافة ملاحظة على إداري (إيجابية/سلبية)')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('type').setDescription('نوع الملاحظة').setRequired(true)
          .addChoices(
            { name: '🟢 ملاحظة إيجابية (+5 نقطة)', value: 'positive' },
            { name: '🟡 ملاحظة سلبية (-10 نقطة)', value: 'negative' }
          )),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        const user = i.options.getUser('user');
        const type = i.options.getString('type');
        const target = staffService.get(user.id);
        if (!target) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        if (user.id === i.user.id) return replyEphemeral(i, '❌ لا يمكنك إضافة ملاحظة على نفسك.', COLORS.danger);
        
        const def = NOTE_TYPES[type];
        if (i.staffLevel < def.minLevel) return replyEphemeral(i, `❌ ${def.label} يتطلب صلاحية أعلى.`, COLORS.danger);
        
        return forms.open(i, { ...modals.note({ type }), title: `📝 تسجيل ملاحظة: ${def.label}` });
      },
    },
  ],

  components: {
    'punish:warning': async (i) => {
      const type = i.values[0];
      if (!WARNING_TYPES[type]) return replyEphemeral(i, '❌ نوع الإنذار غير صحيح.', COLORS.danger);
      return forms.open(i, modals.warning({ type }));
    },
    
    'punish:note': async (i) => {
      const type = i.values[0];
      if (!NOTE_TYPES[type]) return replyEphemeral(i, '❌ نوع الملاحظة غير صحيح.', COLORS.danger);
      return forms.open(i, modals.note({ type }));
    },

    'punish:warningok': async (i, [token]) => {
      const draft = getDraft(i, token);
      if (!draft) return replyEphemeral(i, '⌛ انتهت صلاحية هذه البطاقة. أعد تنفيذ **/warn** من جديد.', COLORS.warning);
      drafts.delete(token);
      
      const target = forms.value(i, 'target');
      const presets = forms.value(i, 'preset').split(/\s*[,،]\s*/).filter(Boolean);
      const reason = forms.combine(i, { select: 'preset', text: 'reason' });
      if (!ID_RE.test(target)) return replyEphemeral(i, '❌ لم يُحدَّد العضو بشكل صحيح. اختر العضو من قائمة النموذج.', COLORS.danger);
      if (!reason) return replyEphemeral(i, 'اختر سبباً جاهزاً أو اكتب تفاصيل السبب قبل المتابعة.', COLORS.danger);
      
      const def = WARNING_TYPES[draft.type];
      const db = getDb();
      const res = db.prepare('INSERT INTO warnings (user_id, warning_type, reason, issued_by) VALUES (?, ?, ?, ?)')
        .run(draft.target, draft.type, reason, i.user.id);
      
      const earned = points.add(draft.target, draft.type === 'verbal' ? 'verbal_warning' : 'formal_warning', staffService.get(draft.target)?.team, { refType: 'warning', refId: res.lastInsertRowid, addedBy: i.user.id });
      
      audit.record({ action: 'staff_warning_issued', actorId: i.user.id, targetId: draft.target, details: { type: draft.type, reason, rowId: res.lastInsertRowid }, channelId: i.channelId });
      
      let extra = '';
      if (def.suspend) {
        const until = points.setCooldown(draft.target, 'suspended', COOLDOWNS.suspended);
        staffService.suspend(draft.target, until);
        extra = `\n⛔ تم الإيقاف + تجميد الترقية حتى ${until}\n↩️ يُرفع الإيقاف تلقائياً في ${until} (أو يدوياً بـ \`/unsuspend\`)`;
      } else if (def.freezeDays) { 
        const until = points.setCooldown(draft.target, 'warning', def.freezeDays); 
        extra = `\n🧊 تجميد الترقيةまで ${until}`; 
      }
      
      const e = warningCard(draft, { rowId: res.lastInsertRowid, earned });
      await sendToChannel(i.client, 'staff-logs', { embeds: [e] });
      await i.update({ embeds: [e], components: [] });
      
      if (def.suspend) {
        await dm(i.client, draft.target, { embeds: [kit.card({
          title: `⛔ تم الإيقاف`,
          description: `تم إصدار **${def.label}** عليك وإيقافك عن العمل.\n**السبب:** ${reason}\n${extra}\n\nبواسطة: <@${i.user.id}>`,
          color: COLORS.danger,
          footer: kit.footerLine(`بواسطة <@${i.user.id}>`),
        })] }).catch(() => {});
      } else {
        await dm(i.client, draft.target, { embeds: [kit.card({
          title: `${def.emoji} ${def.label}`,
          description: `**السبب:** ${reason}\n**النقاط:** ${earned}${extra}\n\nبواسطة: <@${i.user.id}>`,
          color: COLORS.warning,
          footer: kit.footerLine(`بواسطة <@${i.user.id}>`),
        })] }).catch(() => {});
      }
      
      await replyEphemeral(i, `${def.emoji} تم إصدار **${def.label}** على <@${draft.target}> (${earned} نقطة).${extra}`, COLORS.warning);
      return log(i.client, `${def.emoji} ${def.label}`, `على <@${draft.target}> بواسطة <@${i.user.id}>\n${reason}${extra}`, COLORS.danger);
    },

    'punish:warnedit': async (i, [token]) => {
      const draft = getDraft(i, token);
      if (!draft) return replyEphemeral(i, '⌛ انتهت صلاحية هذه البطاقة. ابدأ من جديد.', COLORS.warning);
      drafts.delete(token);
      return forms.open(i, modals.warning({ type: draft.type }), {
        values: { target: draft.target, reason: draft.presetReason || '', preset: draft.presets },
      });
    },

    'punish:warningcancel': async (i, [token]) => {
      const draft = getDraft(i, token);
      if (draft && draft.actorId === i.user.id) drafts.delete(token);
      return i.update({ embeds: [kit.notice('neutral', 'أُلغي الإنذار', 'لم يُسجَّل أي إنذار ولم تُخصم نقاط.', { footer: kit.footerLine('⚠️ إنذار ملغى') })], components: [] });
    },

    'punish:notekok': async (i, [token]) => {
      const draft = getDraft(i, token);
      if (!draft) return replyEphemeral(i, '⌛ انتهت صلاحية هذه البطاقة. أعد تنفيذ **/note** من جديد.', COLORS.warning);
      drafts.delete(token);
      
      const target = forms.value(i, 'target');
      const content = forms.value(i, 'content');
      const isSecret = forms.value(i, 'secret') === 'true';
      if (!ID_RE.test(target)) return replyEphemeral(i, '❌ لم يُحدَّد العضو بشكل صحيح. اختر العضو من قائمة النموذج.', COLORS.danger);
      if (!content) return replyEphemeral(i, 'اكتب محتوى الملاحظة قبل المتابعة.', COLORS.danger);
      
      const def = NOTE_TYPES[draft.type];
      const db = getDb();
      const res = db.prepare('INSERT INTO staff_notes (user_id, note_type, content, is_secret, added_by) VALUES (?, ?, ?, ?, ?)')
        .run(draft.target, draft.type, content, isSecret ? 1 : 0, i.user.id);
      
      const earned = points.add(draft.target, draft.type === 'positive' ? 'positive_note' : 'negative_note', staffService.get(draft.target)?.team, { refType: 'note', refId: res.lastInsertRowid, addedBy: i.user.id });
      
      audit.record({ action: 'staff_note_added', actorId: i.user.id, targetId: draft.target, details: { type: draft.type, secret: !!isSecret, rowId: res.lastInsertRowid }, channelId: i.channelId });
      
      const e = noteCard(draft, { rowId: res.lastInsertRowid, earned });
      await sendToChannel(i.client, 'staff-logs', { embeds: [e] });
      await i.update({ embeds: [e], components: [] });
      
      await dm(i.client, draft.target, { embeds: [kit.card({
        title: `${def.emoji} ${def.label} جديدة`,
        description: `${content}\n\n**النقاط:** ${earned > 0 ? '+' : ''}${earned}`,
        color: draft.type === 'positive' ? COLORS.success : COLORS.warning,
        footer: kit.footerLine(`بواسطة <@${i.user.id}>`),
      })] }).catch(() => {});
      
      await replyEphemeral(i, `${def.emoji} تمت إضافة ${def.label} على <@${draft.target}> (${earned > 0 ? '+' : ''}${earned} نقطة)${isSecret ? ' 🔒' : ''}.`, COLORS.success);
      if (!isSecret) await dm(i.client, draft.target, { embeds: [kit.card({
        title: `${def.emoji} ${def.label} جديدة`,
        description: `${content}\n\n**النقاط:** ${earned > 0 ? '+' : ''}${earned}`,
        color: draft.type === 'positive' ? COLORS.success : COLORS.warning,
        footer: kit.footerLine(`بواسطة <@${i.user.id}>`),
      })] }).catch(() => {});
      
      return log(i.client, `${def.emoji} ${def.label}${isSecret ? ' 🔒' : ''}`, `على <@${draft.target}> بواسطة <@${i.user.id}>\n${content}`, COLORS.gray);
    },

    'punish:noteedit': async (i, [token]) => {
      const draft = getDraft(i, token);
      if (!draft) return replyEphemeral(i, '⌛ انتهت صلاحية هذه البطاقة. ابدأ من جديد.', COLORS.warning);
      drafts.delete(token);
      return forms.open(i, modals.note({ type: draft.type }), {
        values: { target: draft.target, content: draft.content || '', secret: draft.is_secret ? 'true' : 'false' },
      });
    },

    'punish:notecancel': async (i, [token]) => {
      const draft = getDraft(i, token);
      if (draft && draft.actorId === i.user.id) drafts.delete(token);
      return i.update({ embeds: [kit.notice('neutral', 'أُلغيت الملاحظة', 'لم تُسجَّل أي ملاحظة ولم تتغير النقاط.', { footer: kit.footerLine('📝 ملاحظة ملغاة') })], components: [] );
    },
  },
};