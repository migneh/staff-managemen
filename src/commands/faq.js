'use strict';
const {
  SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType,
} = require('discord.js');
const { LEVELS, FAQ_CATEGORIES } = require('../constants');
const faq = require('../services/faq');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, truncate, sendToChannel } = require('../utils');

const categoryChoices = FAQ_CATEGORIES.map(c => ({ name: `${c.id}. ${c.name}`, value: c.id }));
const allCategoryIds = () => FAQ_CATEGORIES.map(c => c.id);

function templateOrDefault(id) { return faq.template(Number(id) || 0) || faq.DEFAULT_TEMPLATE; }

// ===== بناء لوحة مستقلة لكل قالب =====
function buildPanel(templateId = 0) {
  const t = templateOrDefault(templateId);
  const categories = faq.templateCategories(t.id);
  const counts = faq.counts(t.categoryIds);
  const entries = faq.listForTemplate(t.id);
  const important = entries.filter(x => x.is_important).length;
  const suffix = t.id ? `:${t.id}` : '';
  const e = embed(t.title, t.description || 'اختر تصنيفاً من القائمة لعرض المدخلات.', t.color)
    .addFields(
      { name: '📂 التصنيفات', value: categories.slice(0, 6).map(c => `\`${String(c.id).padStart(2, '0')}\` ${c.name} · **${counts[c.id] || 0}**`).join('\n') || 'لا توجد تصنيفات' , inline: true },
      { name: '\u200b', value: categories.slice(6).map(c => `\`${String(c.id).padStart(2, '0')}\` ${c.name} · **${counts[c.id] || 0}**`).join('\n') || '\u200b', inline: true },
      { name: '\u200b', value: `📦 **${entries.length}** مدخل • 📌 **${important}** يتطلب تأكيد قراءة` },
    )
    .setFooter({ text: `قالب #${t.id || 'افتراضي'} • تتحدث هذه اللوحة عند تعديل القالب أو المدخلات` });
  const menu = new StringSelectMenuBuilder().setCustomId(`faq:cat${suffix}`)
    .setPlaceholder('📂 اختر التصنيف...')
    .addOptions(categories.map(c => ({ label: c.name, value: String(c.id), description: truncate(c.desc, 90), emoji: '📄' })));
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`faq:all${suffix}`).setLabel('عرض الكل').setEmoji('📋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`faq:search${suffix}`).setLabel('بحث').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`faq:unread${suffix}`).setLabel('غير المقروءة').setEmoji('📌').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(menu), buttons] };
}

async function refreshPanels(client) {
  let ok = 0;
  for (const p of faq.panels()) {
    try {
      const ch = await client.channels.fetch(p.channel_id);
      const msg = await ch.messages.fetch(p.message_id);
      await msg.edit(buildPanel(p.template_id || 0));
      ok++;
    } catch { faq.removePanel(p.message_id); }
  }
  return ok;
}

function entryEmbed(entry, userId) {
  const cat = faq.category(entry.category_id);
  const e = embed(`${entry.is_important ? '📌 ' : ''}${entry.title}`, entry.content, entry.is_important ? COLORS.warning : COLORS.info)
    .setFooter({ text: `#${entry.id} • ${cat?.name || '—'} • الإصدار ${entry.version}` });
  const row = new ActionRowBuilder();
  if (entry.is_important) {
    const read = userId ? faq.hasRead(entry.id, userId) : false;
    row.addComponents(new ButtonBuilder().setCustomId(`faq:ack:${entry.id}`).setLabel(read ? 'تمت القراءة' : 'تأكيد القراءة')
      .setEmoji('✅').setStyle(read ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(read));
  }
  return { embeds: [e], components: row.components.length ? [row] : [] };
}

function listEmbed(entries, title) {
  if (!entries.length) return embed(title, 'لا توجد مدخلات.', COLORS.gray);
  const byCat = {};
  for (const en of entries) (byCat[en.category_id] ||= []).push(en);
  const e = embed(title, null, COLORS.info);
  for (const [cid, list] of Object.entries(byCat)) {
    e.addFields({ name: `📂 ${faq.category(cid)?.name || cid}`, value: list.map(x => `\`#${x.id}\` ${x.is_important ? '📌 ' : ''}${x.title}`).join('\n').slice(0, 1024) });
  }
  return e;
}

function entrySelectRow(entries, templateId = 0, placeholder = 'اختر مدخلاً لعرضه...') {
  if (!entries.length) return [];
  const suffix = Number(templateId) ? `:${Number(templateId)}` : '';
  const menu = new StringSelectMenuBuilder().setCustomId(`faq:view${suffix}`).setPlaceholder(placeholder)
    .addOptions(entries.slice(0, 25).map(x => ({ label: truncate(`#${x.id} ${x.title}`, 100), value: String(x.id), description: truncate(x.content.replace(/\s+/g, ' '), 90) })));
  return [new ActionRowBuilder().addComponents(menu)];
}

function templateListEmbed() {
  const rows = faq.templates();
  if (!rows.length) return embed('🧩 قوالب FAQ', 'لا توجد قوالب مخصصة بعد. استخدم `/faq-template-create` لإنشاء أول قالب.', COLORS.gray);
  return embed('🧩 قوالب FAQ', rows.map(t => `**#${t.id} — ${t.name}**\n╰ ${t.title} • ${t.categoryIds.length} تصنيف • الإصدار ${t.version}`).join('\n\n'), COLORS.info)
    .setFooter({ text: 'كل قالب مستقل ويمكن نشره في أي قناة وتحديثه دون تغيير القوالب الأخرى.' });
}

function parseCategories(raw) {
  const value = String(raw || '').trim();
  if (!value || /^all|الكل$/i.test(value)) return allCategoryIds();
  const ids = [...new Set(value.split(/[،,\s]+/).filter(Boolean).map(Number))];
  return ids.length && ids.every(id => faq.category(id)) ? ids : null;
}

function parseColor(raw, fallback = faq.DEFAULT_TEMPLATE.color) {
  const value = String(raw || '').trim().replace(/^#/, '').replace(/^0x/i, '');
  if (!value) return fallback;
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  return Number.parseInt(value, 16);
}

const templateModal = (id, prefill = {}) => {
  const m = new ModalBuilder().setCustomId(id ? `faq:template-editmodal:${id}` : 'faq:template-addmodal')
    .setTitle(id ? `تعديل قالب #${id}` : 'إنشاء قالب FAQ');
  m.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('اسم القالب').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true).setValue(prefill.name || '')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('عنوان اللوحة').setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(true).setValue(prefill.title || '')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('وصف اللوحة — اختياري').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(false).setValue(prefill.description || '')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('categories').setLabel('التصنيفات: all أو أرقام مثل 1,3,9').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false).setValue(prefill.categoryIds?.join(',') || 'all')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('لون Hex اختياري مثل #5865F2').setStyle(TextInputStyle.Short).setMaxLength(7).setRequired(false).setValue(prefill.color != null ? `#${Number(prefill.color).toString(16).padStart(6, '0')}` : '#5865F2')),
  );
  return m;
};

function readTemplateFields(i) {
  const categoryIds = parseCategories(i.fields.getTextInputValue('categories'));
  if (!categoryIds) return { error: '❌ التصنيفات غير صحيحة. استخدم all أو أرقاماً من 1 إلى 11 مفصولة بفواصل.' };
  const color = parseColor(i.fields.getTextInputValue('color'));
  if (color == null) return { error: '❌ اللون غير صحيح. استخدم صيغة Hex مثل #5865F2.' };
  return {
    name: i.fields.getTextInputValue('name').trim(),
    title: i.fields.getTextInputValue('title').trim(),
    description: (i.fields.getTextInputValue('description') || '').trim(),
    categoryIds, color,
  };
}

async function notifyUpdate(client, action, entry, userId) {
  const cat = faq.category(entry.category_id);
  const labels = { create: '🆕 مدخل جديد', edit: '✏️ تعديل مدخل', delete: '🗑️ حذف مدخل' };
  const e = embed(`${labels[action]} في قاعدة المعرفة`, `**${entry.title}**\n📂 ${cat?.name}\n👤 بواسطة <@${userId}>\n🆔 \`#${entry.id}\` • الإصدار ${entry.version}`,
    action === 'delete' ? COLORS.danger : COLORS.success);
  await sendToChannel(client, 'staff-updates', { embeds: [e] });
  await refreshPanels(client);
}

const entryModal = (id, prefill = {}) => {
  const m = new ModalBuilder().setCustomId(id ? `faq:editmodal:${id}` : 'faq:addmodal').setTitle(id ? `تعديل المدخل #${id}` : 'إضافة مدخل FAQ');
  m.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('العنوان').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true).setValue(prefill.title || '')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('content').setLabel('المحتوى').setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true).setValue(prefill.content || '')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('category').setLabel('رقم التصنيف (1-11)').setStyle(TextInputStyle.Short).setMaxLength(2).setRequired(true).setValue(String(prefill.category_id || ''))),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('important').setLabel('مهم؟ يتطلب تأكيد قراءة (نعم/لا)').setStyle(TextInputStyle.Short).setMaxLength(3).setRequired(false).setValue(prefill.is_important ? 'نعم' : 'لا')),
  );
  return m;
};

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('faq').setDescription('عرض قاعدة المعرفة (القوانين والتعليمات)')
        .addIntegerOption(o => o.setName('category').setDescription('التصنيف').addChoices(...categoryChoices)),
      level: LEVELS.STAFF,
      async execute(i) {
        const cid = i.options.getInteger('category');
        if (!cid) return i.reply({ ...buildPanel(0), ephemeral: true });
        const entries = faq.list(cid);
        return i.reply({ embeds: [listEmbed(entries, `📂 ${faq.category(cid).name}`)], components: entrySelectRow(entries, 0), ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-list').setDescription('عرض كل مدخلات قاعدة المعرفة'),
      level: LEVELS.STAFF,
      async execute(i) {
        const entries = faq.list();
        return i.reply({ embeds: [listEmbed(entries, '📋 كل المدخلات')], components: entrySelectRow(entries, 0), ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-add').setDescription('إضافة مدخل جديد إلى قاعدة المعرفة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) { return i.showModal(entryModal(null)); },
    },
    {
      data: new SlashCommandBuilder().setName('faq-edit').setDescription('تعديل مدخل في قاعدة المعرفة')
        .addIntegerOption(o => o.setName('id').setDescription('رقم المدخل').setRequired(true)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const entry = faq.get(i.options.getInteger('id'));
        if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
        return i.showModal(entryModal(entry.id, entry));
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-delete').setDescription('حذف مدخل من قاعدة المعرفة')
        .addIntegerOption(o => o.setName('id').setDescription('رقم المدخل').setRequired(true)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const entry = faq.get(i.options.getInteger('id'));
        if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`faq:delconfirm:${entry.id}`).setLabel('تأكيد الحذف').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
          new ButtonBuilder().setCustomId('faq:cancel').setLabel('إلغاء').setStyle(ButtonStyle.Secondary));
        return i.reply({ embeds: [embed('⚠️ تأكيد الحذف', `هل تريد حذف **${entry.title}** (#${entry.id})؟\nسيبقى محفوظاً في سجل التاريخ.`, COLORS.warning)], components: [row], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-panel').setDescription('نشر اللوحة الافتراضية في هذه القناة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const msg = await i.channel.send(buildPanel(0));
        faq.addPanel(msg.id, i.channelId, i.user.id, 0);
        return replyEphemeral(i, '✅ تم نشر اللوحة الافتراضية. استخدم قوالب FAQ إذا أردت لوحات مستقلة متعددة.', COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-template-create').setDescription('إنشاء قالب FAQ مستقل'),
      level: LEVELS.MANAGEMENT,
      async execute(i) { return i.showModal(templateModal()); },
    },
    {
      data: new SlashCommandBuilder().setName('faq-template-list').setDescription('عرض قوالب FAQ المستقلة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) { return i.reply({ embeds: [templateListEmbed()], ephemeral: true }); },
    },
    {
      data: new SlashCommandBuilder().setName('faq-template-edit').setDescription('تعديل قالب FAQ دون التأثير على القوالب الأخرى')
        .addIntegerOption(o => o.setName('id').setDescription('رقم القالب').setRequired(true)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const t = faq.template(i.options.getInteger('id'));
        if (!t || t.id === 0) return replyEphemeral(i, '❌ القالب غير موجود أو لا يمكن تعديل الافتراضي.', COLORS.danger);
        return i.showModal(templateModal(t.id, t));
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-template-send').setDescription('نشر قالب FAQ في أي قناة')
        .addIntegerOption(o => o.setName('id').setDescription('رقم القالب').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('القناة التي ستُنشر فيها اللوحة').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const id = i.options.getInteger('id');
        const t = faq.template(id);
        if (!t || t.id === 0) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
        const channel = i.options.getChannel('channel');
        try {
          const msg = await channel.send(buildPanel(t.id));
          faq.addPanel(msg.id, channel.id, i.user.id, t.id);
          audit.record({ action: 'faq_template_published', actorId: i.user.id, details: { templateId: t.id, channelId: channel.id, messageId: msg.id }, channelId: i.channelId });
          return replyEphemeral(i, `✅ تم نشر القالب **#${t.id} — ${t.name}** في <#${channel.id}>.\nتعديل هذا القالب سيحدث لوحاته فقط.`, COLORS.success);
        } catch (e) { return replyEphemeral(i, `❌ لم أستطع النشر في القناة: ${e.message}`, COLORS.danger); }
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-template-delete').setDescription('حذف قالب FAQ وإرجاع لوحاته للافتراضي')
        .addIntegerOption(o => o.setName('id').setDescription('رقم القالب').setRequired(true)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const t = faq.template(i.options.getInteger('id'));
        if (!t || t.id === 0) return replyEphemeral(i, '❌ القالب غير موجود أو لا يمكن حذف الافتراضي.', COLORS.danger);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`faq:templatedelconfirm:${t.id}`).setLabel('تأكيد حذف القالب').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
          new ButtonBuilder().setCustomId('faq:cancel').setLabel('إلغاء').setStyle(ButtonStyle.Secondary));
        return i.reply({ embeds: [embed('⚠️ حذف قالب FAQ', `هل تريد حذف **${t.name}** (#${t.id})؟\nاللوحات المنشورة ستتحول إلى اللوحة الافتراضية ولن تُحذف رسائلها.`, COLORS.warning)], components: [row], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-refresh').setDescription('تحديث كل لوحات FAQ والقوالب المنشورة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        await i.deferReply({ ephemeral: true });
        const n = await refreshPanels(i.client);
        return replyEphemeral(i, `🔄 تم تحديث **${n}** لوحة.`, COLORS.success);
      },
    },
  ],

  components: {
    'faq:cat': async (i, [templateId]) => {
      const t = templateOrDefault(templateId);
      const cid = Number(i.values[0]);
      const entries = faq.listForTemplate(t.id, cid);
      return i.reply({ embeds: [listEmbed(entries, `📂 ${faq.category(cid).name} • ${t.name}`)], components: entrySelectRow(entries, t.id), ephemeral: true });
    },
    'faq:view': async (i) => {
      const entry = faq.get(Number(i.values[0]));
      if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
      return i.reply({ ...entryEmbed(entry, i.user.id), ephemeral: true });
    },
    'faq:all': async (i, [templateId]) => {
      const t = templateOrDefault(templateId);
      const entries = faq.listForTemplate(t.id);
      return i.reply({ embeds: [listEmbed(entries, `📋 ${t.name} — كل المدخلات`)], components: entrySelectRow(entries, t.id), ephemeral: true });
    },
    'faq:unread': async (i, [templateId]) => {
      const t = templateOrDefault(templateId);
      const allowed = new Set(t.categoryIds);
      const entries = faq.unreadFor(i.user.id).filter(entry => allowed.has(entry.category_id));
      const e = entries.length ? listEmbed(entries, `📌 ${t.name} — مدخلات مهمة لم تقرأها بعد`).setColor(COLORS.warning) : embed('✅ ممتاز', 'قرأت كل المدخلات المهمة في هذا القالب.', COLORS.success);
      return i.reply({ embeds: [e], components: entrySelectRow(entries, t.id, 'اختر مدخلاً لقراءته وتأكيده...'), ephemeral: true });
    },
    'faq:search': async (i, [templateId]) => {
      const suffix = Number(templateId) ? `:${Number(templateId)}` : '';
      const m = new ModalBuilder().setCustomId(`faq:searchmodal${suffix}`).setTitle('🔍 بحث في قاعدة المعرفة');
      m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('q').setLabel('كلمة البحث').setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(60).setRequired(true)));
      return i.showModal(m);
    },
    'faq:searchmodal': async (i, [templateId]) => {
      const t = templateOrDefault(templateId);
      const allowed = new Set(t.categoryIds);
      const q = i.fields.getTextInputValue('q');
      const entries = faq.search(q).filter(entry => allowed.has(entry.category_id));
      return i.reply({ embeds: [listEmbed(entries, `🔍 ${t.name} — نتائج البحث عن: ${q}`)], components: entrySelectRow(entries, t.id), ephemeral: true });
    },
    'faq:ack': async (i, [id]) => {
      const entry = faq.get(Number(id));
      if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
      faq.acknowledge(entry.id, i.user.id, entry.version);
      return i.update(entryEmbed(entry, i.user.id));
    },
    'faq:addmodal': async (i) => {
      const categoryId = Number(i.fields.getTextInputValue('category'));
      if (!faq.category(categoryId)) return replyEphemeral(i, '❌ رقم التصنيف غير صحيح (1-11).', COLORS.danger);
      const important = /^(نعم|y|yes|1)$/i.test(i.fields.getTextInputValue('important').trim());
      const entry = faq.add({ categoryId, title: i.fields.getTextInputValue('title'), content: i.fields.getTextInputValue('content'), important, userId: i.user.id });
      await replyEphemeral(i, `✅ تمت إضافة المدخل **#${entry.id}**.`, COLORS.success);
      return notifyUpdate(i.client, 'create', entry, i.user.id);
    },
    'faq:editmodal': async (i, [id]) => {
      const categoryId = Number(i.fields.getTextInputValue('category'));
      if (!faq.category(categoryId)) return replyEphemeral(i, '❌ رقم التصنيف غير صحيح (1-11).', COLORS.danger);
      const important = /^(نعم|y|yes|1)$/i.test(i.fields.getTextInputValue('important').trim());
      const entry = faq.edit(Number(id), { categoryId, title: i.fields.getTextInputValue('title'), content: i.fields.getTextInputValue('content'), important, userId: i.user.id });
      if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
      await replyEphemeral(i, `✅ تم تعديل المدخل **#${entry.id}** (الإصدار ${entry.version}).`, COLORS.success);
      return notifyUpdate(i.client, 'edit', entry, i.user.id);
    },
    'faq:template-addmodal': async (i) => {
      const fields = readTemplateFields(i);
      if (fields.error) return replyEphemeral(i, fields.error, COLORS.danger);
      try {
        const t = faq.addTemplate({ ...fields, userId: i.user.id });
        audit.record({ action: 'faq_template_created', actorId: i.user.id, targetId: String(t.id), details: { name: t.name, categoryIds: t.categoryIds }, channelId: i.channelId });
        return replyEphemeral(i, `✅ تم إنشاء القالب **#${t.id} — ${t.name}**. استخدم \`/faq-template-send id:${t.id}\` لنشره.`, COLORS.success);
      } catch (e) { return replyEphemeral(i, `❌ تعذر إنشاء القالب: ${e.message}`, COLORS.danger); }
    },
    'faq:template-editmodal': async (i, [id]) => {
      const fields = readTemplateFields(i);
      if (fields.error) return replyEphemeral(i, fields.error, COLORS.danger);
      try {
        const t = faq.editTemplate(Number(id), { ...fields, userId: i.user.id });
        if (!t) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
        audit.record({ action: 'faq_template_edited', actorId: i.user.id, targetId: String(t.id), details: { version: t.version, name: t.name, categoryIds: t.categoryIds }, channelId: i.channelId });
        await replyEphemeral(i, `✅ تم تعديل القالب **#${t.id}** إلى الإصدار ${t.version}. سيتم تحديث لوحاته المنشورة فقط.`, COLORS.success);
        return refreshPanels(i.client);
      } catch (e) { return replyEphemeral(i, `❌ تعذر تعديل القالب: ${e.message}`, COLORS.danger); }
    },
    'faq:templatedelconfirm': async (i, [id]) => {
      const t = faq.removeTemplate(Number(id), i.user.id);
      if (!t) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
      audit.record({ action: 'faq_template_deleted', actorId: i.user.id, targetId: String(t.id), details: { name: t.name }, channelId: i.channelId });
      await i.update({ embeds: [embed('🗑️ تم حذف القالب', `تم حذف **${t.name}** (#${t.id}). اللوحات المرتبطة به أصبحت افتراضية.`, COLORS.danger)], components: [] });
      return refreshPanels(i.client);
    },
    'faq:delconfirm': async (i, [id]) => {
      const entry = faq.remove(Number(id), i.user.id);
      if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
      await i.update({ embeds: [embed('🗑️ تم الحذف', `تم حذف **${entry.title}** (#${entry.id}).`, COLORS.danger)], components: [] });
      return notifyUpdate(i.client, 'delete', entry, i.user.id);
    },
    'faq:cancel': async (i) => i.update({ embeds: [embed(null, 'تم الإلغاء.', COLORS.gray)], components: [] }),
  },

  refreshPanels, buildPanel, templateListEmbed,
};
