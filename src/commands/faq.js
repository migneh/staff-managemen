'use strict';
const {
  SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType,
} = require('discord.js');
const { LEVELS, FAQ_CATEGORIES } = require('../constants');
const faq = require('../services/faq');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, truncate, sendToChannel } = require('../utils');
const kit = require('../ui/kit');

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
  const noteLine = t.note ? `\n> ℹ️ ${t.note}` : '';
  const e = embed(t.title, `${t.description || 'اختر تصنيفاً من القائمة لعرض المدخلات.'}${noteLine}`, t.color)
    .addFields(
      { name: '📂 التصنيفات', value: categories.slice(0, 6).map(c => `\`${String(c.id).padStart(2, '0')}\` ${c.name} · **${counts[c.id] || 0}**`).join('\n') || 'لا توجد تصنيفات', inline: true },
      { name: '\u200b', value: categories.slice(6).map(c => `\`${String(c.id).padStart(2, '0')}\` ${c.name} · **${counts[c.id] || 0}**`).join('\n') || '\u200b', inline: true },
      { name: '\u200b', value: `📦 **${entries.length}** مدخل${t.pinnedIds.length ? ` · 📌 **${t.pinnedIds.length}** مثبت` : ''}${t.excludedIds.length ? ` · 🙈 **${t.excludedIds.length}** مخفي` : ''} • ❗ **${important}** يتطلب تأكيد قراءة` },
    );
  if (t.id) e.setFooter({ text: `قالب #${t.id} — ${t.name} • تتحدث لوحات هذا القالب فقط عند تعديله` });
  else e.setFooter({ text: 'اللوحة الافتراضية • تتحدث عند تعديل أي مدخل' });

  const hasEntries = entries.length > 0;
  const menu = new StringSelectMenuBuilder().setCustomId(`faq:cat${suffix}`)
    .setPlaceholder(hasEntries ? '📂 اختر التصنيف...' : 'لا توجد مدخلات في هذا القالب')
    .setDisabled(!hasEntries)
    .addOptions(hasEntries ? categories.map(c => ({ label: c.name, value: String(c.id), description: truncate(c.desc, 90), emoji: '📄' })) : [{ label: 'لا يوجد', value: '0', description: 'القالب فارغ' }]);
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`faq:all${suffix}`).setLabel('عرض الكل').setEmoji('📋').setStyle(ButtonStyle.Primary).setDisabled(!hasEntries),
    new ButtonBuilder().setCustomId(`faq:search${suffix}`).setLabel('بحث').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`faq:unread${suffix}`).setLabel('غير المقروءة').setEmoji('📌').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(menu), buttons] };
}

async function refreshPanels(client, templateId = null) {
  let ok = 0;
  const list = templateId != null ? faq.panels({ templateId: Number(templateId) }) : faq.panels();
  for (const p of list) {
    try {
      const ch = await client.channels.fetch(p.channel_id);
      const msg = await ch.messages.fetch(p.message_id);
      await msg.edit(buildPanel(p.template_id || 0));
      faq.updatePanelSync(p.message_id, true);
      ok++;
    } catch {
      // لا نحذف تلقائياً — نعلّمها كخطأ ليُصلحها المسؤول من /faq-panels
      try { faq.updatePanelSync(p.message_id, false); } catch {}
    }
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
    row.addComponents(new ButtonBuilder().setCustomId(`faq:ack:${entry.id}`).setLabel(read ? 'تمت القراءة ✓' : 'تأكيد القراءة')
      .setEmoji('✅').setStyle(read ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(read));
  }
  // زر سريع لعرض السجل (للإدارة)
  row.addComponents(new ButtonBuilder().setCustomId(`faq:hist:${entry.id}`).setLabel('السجل').setEmoji('🕘').setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: [row] };
}

function listEmbed(entries, title, { templateId = 0 } = {}) {
  if (!entries.length) return embed(title, '_لا توجد مدخلات تطابق هذا العرض._\n\n💡 جرّب تصنيفاً آخر أو استخدم **بحث**.', COLORS.gray);
  const byCat = {};
  for (const en of entries) (byCat[en.category_id] ||= []).push(en);
  const t = templateOrDefault(templateId);
  const e = embed(title, null, COLORS.info);
  for (const [cid, list] of Object.entries(byCat)) {
    const lines = list.map(x => {
      const pin = t.pinnedIds.includes(x.id) ? '📌 ' : '';
      const imp = x.is_important ? '❗ ' : '';
      return `\`#${x.id}\` ${pin}${imp}${x.title}`;
    });
    // قسّم الحقل إن تجاوز الحد
    const chunks = kit.chunkLines(lines, 1024);
    chunks.forEach((chunk, idx) => {
      e.addFields({ name: idx === 0 ? `📂 ${faq.category(cid)?.name || cid}` : `↳ ${faq.category(cid)?.name || cid} (تابع)`, value: chunk });
    });
  }
  if (entries.length >= 25) e.setFooter({ text: 'يُعرض أول 25 نتيجة — استخدم البحث لتضييق النتائج.' });
  return e;
}

function entrySelectRow(entries, templateId = 0, placeholder = 'اختر مدخلاً لعرضه...') {
  if (!entries.length) return [];
  const suffix = Number(templateId) ? `:${Number(templateId)}` : '';
  const t = templateOrDefault(templateId);
  const options = entries.slice(0, 25).map(x => ({
    label: truncate(`${t.pinnedIds.includes(x.id) ? '📌 ' : ''}#${x.id} ${x.title}`, 100),
    value: String(x.id),
    description: truncate(x.content.replace(/\s+/g, ' '), 90),
    emoji: x.is_important ? '❗' : '📄',
  }));
  const menu = new StringSelectMenuBuilder().setCustomId(`faq:view${suffix}`).setPlaceholder(placeholder).addOptions(options);
  return [new ActionRowBuilder().addComponents(menu)];
}

function templateListEmbed(page = 1) {
  const rows = faq.templates();
  if (!rows.length) return embed('🧩 قوالب FAQ', 'لا توجد قوالب مخصصة بعد.\n\nاستخدم **/faq-template-create** لإنشاء أول قالب — كل قالب يمكن نشره في **روم مختلف** وتعديله **وحده** دون لمس القوالب الأخرى.', COLORS.gray);
  const { items, pages, total } = kit.paginate(rows, page, 5);
  const e = embed('🧩 قوالب FAQ — كل قالب مستقل برومه', items.map(t => {
    const cats = t.categoryIds.length === FAQ_CATEGORIES.length ? 'كل التصنيفات' : `${t.categoryIds.length} تصنيفات`;
    const panels = faq.panels({ templateId: t.id }).length;
    const extra = [
      t.pinnedIds.length ? `📌 ${t.pinnedIds.length} مثبت` : null,
      t.excludedIds.length ? `🙈 ${t.excludedIds.length} مخفي` : null,
      t.note ? `ℹ️ ملاحظة` : null,
    ].filter(Boolean).join(' • ');
    return `**#${t.id} — ${t.name}**\n╰ ${t.title} • ${cats} • **${panels}** لوحة • الإصدار ${t.version}${extra ? `\n╰ ${extra}` : ''}`;
  }).join('\n\n'), COLORS.info)
    .setFooter({ text: `صفحة ${page}/${pages} • ${total} قالب • كل قالب يحدّث لوحاته فقط` });
  return e;
}

function panelsEmbed(templateId = null, page = 1) {
  const all = templateId != null ? faq.panels({ templateId: Number(templateId) }) : faq.panels();
  if (!all.length) return embed('📌 لوحات FAQ المنشورة', templateId != null ? `لا توجد لوحات للقالب **#${templateId}**.` : 'لا توجد لوحات منشورة بعد. استخدم **/faq-template-send** أو **/faq-panel**.', COLORS.gray);
  const { items, pages, total } = kit.paginate(all, page, 8);
  const e = embed(templateId != null ? `📌 لوحات القالب #${templateId}` : '📌 كل لوحات FAQ', items.map(p => {
    const t = templateOrDefault(p.template_id);
    const label = p.label ? ` — ${p.label}` : '';
    const sync = p.sync_status === 'error' ? '⚠️ خطأ مزامنة' : '✅';
    return `${sync} <#${p.channel_id}> • \`${p.message_id.slice(-6)}\` • **${t.name}**${label} • <t:${Math.floor(Date.parse(p.created_at.replace(' ', 'T') + 'Z') / 1000)}:R>`;
  }).join('\n'), COLORS.info)
    .setFooter({ text: `صفحة ${page}/${pages} • ${total} لوحة` });
  return e;
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

function parseEntryIds(raw) {
  const value = String(raw || '').trim();
  if (!value) return [];
  const ids = [...new Set(value.split(/[،,\s]+/).filter(Boolean).map(Number))].filter(Number.isInteger);
  return ids;
}

const templateModal = (id, prefill = {}) => {
  const m = new ModalBuilder().setCustomId(id ? `faq:template-editmodal:${id}` : 'faq:template-addmodal')
    .setTitle(id ? `تعديل قالب #${id}` : 'إنشاء قالب FAQ');
  m.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('اسم القالب (داخلي)').setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true).setValue(prefill.name || '')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('عنوان اللوحة').setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(true).setValue(prefill.title || '')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('وصف اللوحة').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(false).setValue(prefill.description || '')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('categories').setLabel('التصنيفات: all أو أرقام مثل 1,3,9').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false).setValue(prefill.categoryIds?.join(',') || 'all')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('لون #RRGGBB وملاحظة اللوحة (اختياري)').setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(false).setValue(prefill.color != null ? `#${Number(prefill.color).toString(16).padStart(6, '0')}` : '#5865F2')),
  );
  return m;
};

function readTemplateFields(i) {
  const categoryIds = parseCategories(i.fields.getTextInputValue('categories'));
  if (!categoryIds) return { error: '❌ التصنيفات غير صحيحة. استخدم all أو أرقاماً من 1 إلى 11 مفصولة بفواصل.' };
  const color = parseColor(i.fields.getTextInputValue('color').split(/\s+/)[0] || '');
  if (color == null) return { error: '❌ اللون غير صحيح. استخدم صيغة Hex مثل #5865F2 في بداية الحقل.' };
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
        return i.reply({ embeds: [embed('⚠️ تأكيد الحذف', `هل تريد حذف **${entry.title}** (#${entry.id})؟\nسيبقى محفوظاً في سجل التاريخ وسيُزال من القوالب المثبتة/المخفية.`, COLORS.warning)], components: [row], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-panel').setDescription('نشر اللوحة الافتراضية في هذه القناة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const msg = await i.channel.send(buildPanel(0));
        faq.addPanel(msg.id, i.channelId, i.user.id, 0);
        return replyEphemeral(i, '✅ تم نشر اللوحة الافتراضية. استخدم قوالب FAQ إذا أردت لوحات مستقلة — كل قالب يُنشر في رومه ويُعدّل وحده.', COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-template-create').setDescription('إنشاء قالب FAQ مستقل (لكل روم قالب)'),
      level: LEVELS.MANAGEMENT,
      async execute(i) { return i.showModal(templateModal()); },
    },
    {
      data: new SlashCommandBuilder().setName('faq-template-list').setDescription('عرض قوالب FAQ المستقلة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const e = templateListEmbed(1);
        const rows = faq.templates();
        if (!rows.length) return i.reply({ embeds: [e], ephemeral: true });
        const { pages } = kit.paginate(rows, 1, 5);
        const nav = pages > 1 ? [kit.navRow({ prefix: 'faq:tmpllist', page: 1, pages })] : [];
        return i.reply({ embeds: [e], components: nav, ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-template-edit').setDescription('تعديل قالب FAQ — يحدّث لوحات هذا القالب فقط')
        .addIntegerOption(o => o.setName('id').setDescription('رقم القالب').setRequired(true)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const t = faq.template(i.options.getInteger('id'));
        if (!t || t.id === 0) return replyEphemeral(i, '❌ القالب غير موجود أو لا يمكن تعديل الافتراضي.', COLORS.danger);
        return i.showModal(templateModal(t.id, t));
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-template-send').setDescription('نشر قالب FAQ في أي قناة — كل قالب برومه')
        .addIntegerOption(o => o.setName('id').setDescription('رقم القالب').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('القناة التي ستُنشر فيها اللوحة').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption(o => o.setName('label').setDescription('اسم يميّز هذه اللوحة (اختياري)').setRequired(false).setMaxLength(60)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const id = i.options.getInteger('id');
        const t = faq.template(id);
        if (!t || t.id === 0) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
        const channel = i.options.getChannel('channel');
        const label = i.options.getString('label') || null;
        try {
          const msg = await channel.send(buildPanel(t.id));
          faq.addPanel(msg.id, channel.id, i.user.id, t.id, { label });
          audit.record({ action: 'faq_template_published', actorId: i.user.id, details: { templateId: t.id, channelId: channel.id, messageId: msg.id, label }, channelId: i.channelId });
          return replyEphemeral(i, `✅ تم نشر القالب **#${t.id} — ${t.name}** في <#${channel.id}>${label ? ` باسم «${label}»` : ''}.\nتعديل هذا القالب سيحدّث لوحاته فقط — باقي القوالب لا تتأثر.`, COLORS.success);
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
        const panels = faq.panels({ templateId: t.id });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`faq:templatedelconfirm:${t.id}`).setLabel('تأكيد حذف القالب').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
          new ButtonBuilder().setCustomId('faq:cancel').setLabel('إلغاء').setStyle(ButtonStyle.Secondary));
        return i.reply({ embeds: [embed('⚠️ حذف قالب FAQ', `هل تريد حذف **${t.name}** (#${t.id})؟\n${panels.length ? `لديه **${panels.length}** لوحة منشورة — ستصبح افتراضية ولن تُحذف رسائلها.` : 'لا توجد لوحات منشورة له.'}`, COLORS.warning)], components: [row], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-panels').setDescription('عرض كل لوحات FAQ المنشورة وحالتها')
        .addIntegerOption(o => o.setName('template').setDescription('تصفية بقالب محدد').setRequired(false)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const tid = i.options.getInteger('template');
        if (tid != null && !faq.template(tid)) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
        const e = panelsEmbed(tid, 1);
        const all = tid != null ? faq.panels({ templateId: tid }) : faq.panels();
        const { pages } = kit.paginate(all, 1, 8);
        const nav = pages > 1 ? [kit.navRow({ prefix: `faq:panels:${tid ?? 'all'}`, page: 1, pages })] : [];
        return i.reply({ embeds: [e], components: nav, ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-template-config').setDescription('إعداد متقدم للقالب: تثبيت/إخفاء مدخلات وملاحظة اللوحة')
        .addIntegerOption(o => o.setName('id').setDescription('رقم القالب').setRequired(true)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const t = faq.template(i.options.getInteger('id'));
        if (!t || t.id === 0) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
        const e = embed(`⚙️ إعداد القالب #${t.id} — ${t.name}`, [
          `**العنوان:** ${t.title}`,
          `**التصنيفات:** ${t.categoryIds.join(', ')}`,
          `**📌 مثبت:** ${t.pinnedIds.length ? t.pinnedIds.map(id => `\`#${id}\``).join(', ') : '_لا يوجد_'}`,
          `**🙈 مخفي:** ${t.excludedIds.length ? t.excludedIds.map(id => `\`#${id}\``).join(', ') : '_لا يوجد_'}`,
          `**ℹ️ ملاحظة اللوحة:** ${t.note || '_لا يوجد_'}`,
          `**اللون:** \`#${Number(t.color).toString(16).padStart(6, '0')}\``,
          '',
          'استخدم الأزرار أدناه للتعديل — كل تغيير يحدّث **لوحات هذا القالب فقط**.',
        ].join('\n'), COLORS.info);
        const row1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`faq:cfgpin:${t.id}`).setLabel('تثبيت مدخلات').setEmoji('📌').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`faq:cfghide:${t.id}`).setLabel('إخفاء مدخلات').setEmoji('🙈').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`faq:cfgnote:${t.id}`).setLabel('ملاحظة اللوحة').setEmoji('ℹ️').setStyle(ButtonStyle.Secondary),
        );
        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`faq:cfgclear:${t.id}`).setLabel('مسح التثبيت/الإخفاء').setEmoji('🧹').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`faq:cfgrefresh:${t.id}`).setLabel('تحديث لوحاته').setEmoji('🔄').setStyle(ButtonStyle.Primary),
        );
        return i.reply({ embeds: [e], components: [row1, row2], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-refresh').setDescription('تحديث لوحات FAQ')
        .addIntegerOption(o => o.setName('template').setDescription('قالب محدد فقط (اختياري)').setRequired(false)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        await i.deferReply({ ephemeral: true });
        const tid = i.options.getInteger('template');
        const n = await refreshPanels(i.client, tid);
        const label = tid ? ` للقالب #${tid}` : '';
        return replyEphemeral(i, `🔄 تم تحديث **${n}** لوحة${label}.`, COLORS.success);
      },
    },
  ],

  components: {
    'faq:cat': async (i, [templateId]) => {
      const t = templateOrDefault(templateId);
      const cid = Number(i.values[0]);
      const entries = faq.listForTemplate(t.id, cid);
      return i.reply({ embeds: [listEmbed(entries, `📂 ${faq.category(cid).name} • ${t.name}`, { templateId: t.id })], components: entrySelectRow(entries, t.id), ephemeral: true });
    },
    'faq:view': async (i) => {
      const entry = faq.get(Number(i.values[0]));
      if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
      return i.reply({ ...entryEmbed(entry, i.user.id), ephemeral: true });
    },
    'faq:all': async (i, [templateId]) => {
      const t = templateOrDefault(templateId);
      const entries = faq.listForTemplate(t.id);
      return i.reply({ embeds: [listEmbed(entries, `📋 ${t.name} — كل المدخلات`, { templateId: t.id })], components: entrySelectRow(entries, t.id), ephemeral: true });
    },
    'faq:unread': async (i, [templateId]) => {
      const t = templateOrDefault(templateId);
      const entries = faq.unreadFor(i.user.id, { templateId: t.id });
      const e = entries.length ? listEmbed(entries, `📌 ${t.name} — مدخلات مهمة لم تقرأها بعد`, { templateId: t.id }).setColor(COLORS.warning) : embed('✅ ممتاز', 'قرأت كل المدخلات المهمة في هذا القالب.', COLORS.success);
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
      const q = i.fields.getTextInputValue('q');
      const entries = faq.search(q, { templateId: t.id });
      return i.reply({ embeds: [listEmbed(entries, `🔍 ${t.name} — نتائج البحث عن: ${q}`, { templateId: t.id })], components: entrySelectRow(entries, t.id), ephemeral: true });
    },
    'faq:ack': async (i, [id]) => {
      const entry = faq.get(Number(id));
      if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
      faq.acknowledge(entry.id, i.user.id, entry.version);
      // زر غير مفعّل بعد التأكيد
      const updated = entryEmbed(entry, i.user.id);
      try { return await i.update(updated); } catch { return i.reply({ ...updated, ephemeral: true }); }
    },
    'faq:hist': async (i, [id]) => {
      const entry = faq.get(Number(id));
      if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
      const hist = faq.history(entry.id).slice(0, 8);
      if (!hist.length) return replyEphemeral(i, 'لا يوجد سجل لهذا المدخل.', COLORS.gray);
      const e = embed(`🕘 سجل المدخل #${entry.id}`, hist.map(h => `\`v${h.version}\` **${h.action}** — <@${h.changed_by}> • <t:${Math.floor(Date.parse(h.changed_at.replace(' ', 'T') + 'Z') / 1000)}:R>`).join('\n'), COLORS.gray);
      return i.reply({ embeds: [e], ephemeral: true });
    },
    'faq:addmodal': async (i) => {
      const categoryId = Number(i.fields.getTextInputValue('category'));
      if (!faq.category(categoryId)) return replyEphemeral(i, '❌ رقم التصنيف غير صحيح (1-11).', COLORS.danger);
      const important = /^(نعم|y|yes|1)$/i.test(i.fields.getTextInputValue('important').trim());
      const entry = faq.add({ categoryId, title: i.fields.getTextInputValue('title'), content: i.fields.getTextInputValue('content'), important, userId: i.user.id });
      await replyEphemeral(i, `✅ تمت إضافة المدخل **#${entry.id}** — ${faq.category(categoryId).name}${important ? ' (📌 يتطلب تأكيد قراءة)' : ''}.`, COLORS.success);
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
        return replyEphemeral(i, `✅ تم إنشاء القالب **#${t.id} — ${t.name}**.\nاستخدم \`/faq-template-send id:${t.id} channel:#الروم\` لنشره — كل قالب يُنشر في رومه ويُعدّل وحده.`, COLORS.success);
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
        return refreshPanels(i.client, t.id);
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

    // ===== متقدّم: تثبيت/إخفاء/ملاحظة =====
    'faq:cfgpin': async (i, [id]) => {
      const m = new ModalBuilder().setCustomId(`faq:cfgpinmodal:${id}`).setTitle(`📌 تثبيت مدخلات — قالب #${id}`);
      m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ids').setLabel('أرقام المدخلات (مثل: 3, 7, 12) — تُعرض أولاً').setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(true).setValue((faq.template(Number(id))?.pinnedIds || []).join(', '))));
      return i.showModal(m);
    },
    'faq:cfgpinmodal': async (i, [id]) => {
      const ids = parseEntryIds(i.fields.getTextInputValue('ids'));
      const invalid = ids.filter(eid => !faq.get(eid));
      if (invalid.length) return replyEphemeral(i, `❌ هذه المدخلات غير موجودة: ${invalid.join(', ')}`, COLORS.danger);
      const t = faq.editTemplate(Number(id), { pinnedIds: ids, userId: i.user.id });
      if (!t) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
      await replyEphemeral(i, `✅ تم تثبيت **${ids.length}** مدخل في القالب **#${t.id}**.`, COLORS.success);
      return refreshPanels(i.client, t.id);
    },
    'faq:cfghide': async (i, [id]) => {
      const m = new ModalBuilder().setCustomId(`faq:cfghidemodal:${id}`).setTitle(`🙈 إخفاء مدخلات — قالب #${id}`);
      m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ids').setLabel('أرقام المدخلات المخفية في هذا القالب فقط').setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(true).setValue((faq.template(Number(id))?.excludedIds || []).join(', '))));
      return i.showModal(m);
    },
    'faq:cfghidemodal': async (i, [id]) => {
      const ids = parseEntryIds(i.fields.getTextInputValue('ids'));
      const invalid = ids.filter(eid => !faq.get(eid));
      if (invalid.length) return replyEphemeral(i, `❌ هذه المدخلات غير موجودة: ${invalid.join(', ')}`, COLORS.danger);
      const t = faq.editTemplate(Number(id), { excludedIds: ids, userId: i.user.id });
      if (!t) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
      await replyEphemeral(i, `✅ تم إخفاء **${ids.length}** مدخل في هذا القالب فقط.`, COLORS.success);
      return refreshPanels(i.client, t.id);
    },
    'faq:cfgnote': async (i, [id]) => {
      const t = faq.template(Number(id));
      const m = new ModalBuilder().setCustomId(`faq:cfgenotemodal:${id}`).setTitle(`ℹ️ ملاحظة اللوحة — قالب #${id}`);
      m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('note').setLabel('نص يظهر أعلى اللوحة في هذا الروم فقط').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(false).setValue(t?.note || '')));
      return i.showModal(m);
    },
    'faq:cfgenotemodal': async (i, [id]) => {
      const note = (i.fields.getTextInputValue('note') || '').trim();
      const t = faq.editTemplate(Number(id), { note, userId: i.user.id });
      if (!t) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
      await replyEphemeral(i, note ? '✅ تم حفظ ملاحظة اللوحة.' : '✅ تم مسح ملاحظة اللوحة.', COLORS.success);
      return refreshPanels(i.client, t.id);
    },
    'faq:cfgclear': async (i, [id]) => {
      const t = faq.editTemplate(Number(id), { pinnedIds: [], excludedIds: [], userId: i.user.id });
      if (!t) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
      await i.update({ embeds: [embed('🧹 تم المسح', `تم مسح التثبيت والإخفاء للقالب **#${t.id}**.`, COLORS.success)], components: [] });
      return refreshPanels(i.client, t.id);
    },
    'faq:cfgrefresh': async (i, [id]) => {
      await i.deferReply({ ephemeral: true });
      const n = await refreshPanels(i.client, Number(id));
      return replyEphemeral(i, `🔄 تم تحديث **${n}** لوحة للقالب #${id}.`, COLORS.success);
    },

    // ===== ترقيم صفحات =====
    'faq:tmpllist': async (i, [page]) => {
      const rows = faq.templates();
      const { items, pages } = kit.paginate(rows, Number(page), 5);
      if (!items.length) return replyEphemeral(i, 'لا توجد قوالب.', COLORS.gray);
      const nav = pages > 1 ? [kit.navRow({ prefix: 'faq:tmpllist', page: Number(page), pages })] : [];
      return i.update({ embeds: [templateListEmbed(Number(page))], components: nav });
    },
    'faq:panels': async (i, [tid, page]) => {
      const target = tid === 'all' ? null : Number(tid);
      const all = target != null ? faq.panels({ templateId: target }) : faq.panels();
      const { pages: p } = kit.paginate(all, Number(page), 8);
      return i.update({ embeds: [panelsEmbed(target, Number(page))], components: p > 1 ? [kit.navRow({ prefix: `faq:panels:${tid}`, page: Number(page), pages: p })] : [] });
    },
  },

  refreshPanels, buildPanel, templateListEmbed, panelsEmbed,
};
