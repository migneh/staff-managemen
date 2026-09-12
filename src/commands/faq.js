'use strict';
const {
  SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { LEVELS, FAQ_CATEGORIES } = require('../constants');
const faq = require('../services/faq');
const { embed, COLORS, replyEphemeral, truncate, sendToChannel, discordTs } = require('../utils');

const categoryChoices = FAQ_CATEGORIES.map(c => ({ name: `${c.id}. ${c.name}`, value: c.id }));

// ===== بناء اللوحة الثابتة =====
function buildPanel() {
  const counts = faq.counts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const important = faq.list().filter(x => x.is_important).length;
  const e = embed('📚 قاعدة المعرفة — Staff FAQ',
    '> كل ما تحتاج معرفته كإداري في مكان واحد.\n> اختر تصنيفاً من القائمة، أو ابحث، أو اضغط **غير المقروءة** لترى ما ينتظرك.\n\u200b', COLORS.primary)
    .addFields(
      { name: '📂 التصنيفات', value: FAQ_CATEGORIES.slice(0, 6).map(c => `\`${String(c.id).padStart(2, '0')}\` ${c.name} · **${counts[c.id] || 0}**`).join('\n'), inline: true },
      { name: '\u200b', value: FAQ_CATEGORIES.slice(6).map(c => `\`${String(c.id).padStart(2, '0')}\` ${c.name} · **${counts[c.id] || 0}**`).join('\n'), inline: true },
      { name: '\u200b', value: `📦 **${total}** مدخل • 📌 **${important}** يتطلب تأكيد قراءة` },
    )
    .setFooter({ text: 'تتحدث اللوحة تلقائياً عند أي إضافة أو تعديل' });
  const menu = new StringSelectMenuBuilder().setCustomId('faq:cat').setPlaceholder('📂 اختر التصنيف...')
    .addOptions(FAQ_CATEGORIES.map(c => ({ label: c.name, value: String(c.id), description: truncate(c.desc, 90), emoji: '📄' })));
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('faq:all').setLabel('عرض الكل').setEmoji('📋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('faq:search').setLabel('بحث').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('faq:unread').setLabel('غير المقروءة').setEmoji('📌').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(menu), buttons] };
}

async function refreshPanels(client) {
  let ok = 0;
  for (const p of faq.panels()) {
    try {
      const ch = await client.channels.fetch(p.channel_id);
      const msg = await ch.messages.fetch(p.message_id);
      await msg.edit(buildPanel());
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

function entrySelectRow(entries, placeholder = 'اختر مدخلاً لعرضه...') {
  if (!entries.length) return [];
  const menu = new StringSelectMenuBuilder().setCustomId('faq:view').setPlaceholder(placeholder)
    .addOptions(entries.slice(0, 25).map(x => ({ label: truncate(`#${x.id} ${x.title}`, 100), value: String(x.id), description: truncate(x.content.replace(/\s+/g, ' '), 90) })));
  return [new ActionRowBuilder().addComponents(menu)];
}

async function notifyUpdate(client, action, entry, userId) {
  const cat = faq.category(entry.category_id);
  const labels = { create: '🆕 مدخل جديد', edit: '✏️ تعديل مدخل', delete: '🗑️ حذف مدخل' };
  const e = embed(`${labels[action]} في قاعدة المعرفة`, `**${entry.title}**\n📂 ${cat?.name}\n👤 بواسطة <@${userId}>\n🆔 \`#${entry.id}\` • الإصدار ${entry.version}`,
    action === 'delete' ? COLORS.danger : COLORS.success);
  await sendToChannel(client, 'staff-updates', { embeds: [e] });
  await sendToChannel(client, 'staff-faq', { embeds: [e] }).catch(() => {});
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
        if (!cid) return i.reply({ ...buildPanel(), ephemeral: true });
        const entries = faq.list(cid);
        return i.reply({ embeds: [listEmbed(entries, `📂 ${faq.category(cid).name}`)], components: entrySelectRow(entries), ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-list').setDescription('عرض كل مدخلات قاعدة المعرفة'),
      level: LEVELS.STAFF,
      async execute(i) {
        const entries = faq.list();
        return i.reply({ embeds: [listEmbed(entries, '📋 كل المدخلات')], components: entrySelectRow(entries), ephemeral: true });
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
      data: new SlashCommandBuilder().setName('faq-panel').setDescription('إنشاء لوحة FAQ ثابتة في هذه القناة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const msg = await i.channel.send(buildPanel());
        faq.addPanel(msg.id, i.channelId, i.user.id);
        return replyEphemeral(i, '✅ تم إنشاء اللوحة الثابتة وستتحدث تلقائياً.', COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-refresh').setDescription('تحديث كل لوحات FAQ الثابتة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        await i.deferReply({ ephemeral: true });
        const n = await refreshPanels(i.client);
        return replyEphemeral(i, `🔄 تم تحديث **${n}** لوحة.`, COLORS.success);
      },
    },
  ],

  components: {
    'faq:cat': async (i) => {
      const cid = Number(i.values[0]);
      const entries = faq.list(cid);
      return i.reply({ embeds: [listEmbed(entries, `📂 ${faq.category(cid).name}`)], components: entrySelectRow(entries), ephemeral: true });
    },
    'faq:view': async (i) => {
      const entry = faq.get(Number(i.values[0]));
      if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
      return i.reply({ ...entryEmbed(entry, i.user.id), ephemeral: true });
    },
    'faq:all': async (i) => {
      const entries = faq.list();
      return i.reply({ embeds: [listEmbed(entries, '📋 كل المدخلات')], components: entrySelectRow(entries), ephemeral: true });
    },
    'faq:unread': async (i) => {
      const entries = faq.unreadFor(i.user.id);
      const e = entries.length ? listEmbed(entries, '📌 مدخلات مهمة لم تقرأها بعد').setColor(COLORS.warning) : embed('✅ ممتاز', 'قرأت كل المدخلات المهمة.', COLORS.success);
      return i.reply({ embeds: [e], components: entrySelectRow(entries, 'اختر مدخلاً لقراءته وتأكيده...'), ephemeral: true });
    },
    'faq:search': async (i) => {
      const m = new ModalBuilder().setCustomId('faq:searchmodal').setTitle('🔍 بحث في قاعدة المعرفة');
      m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('q').setLabel('كلمة البحث').setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(60).setRequired(true)));
      return i.showModal(m);
    },
    'faq:searchmodal': async (i) => {
      const q = i.fields.getTextInputValue('q');
      const entries = faq.search(q);
      return i.reply({ embeds: [listEmbed(entries, `🔍 نتائج البحث عن: ${q}`)], components: entrySelectRow(entries), ephemeral: true });
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
    'faq:delconfirm': async (i, [id]) => {
      const entry = faq.remove(Number(id), i.user.id);
      if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
      await i.update({ embeds: [embed('🗑️ تم الحذف', `تم حذف **${entry.title}** (#${entry.id}).`, COLORS.danger)], components: [] });
      return notifyUpdate(i.client, 'delete', entry, i.user.id);
    },
    'faq:cancel': async (i) => i.update({ embeds: [embed(null, 'تم الإلغاء.', COLORS.gray)], components: [] }),
  },

  refreshPanels, buildPanel,
};
