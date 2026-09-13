'use strict';
const {
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder,
  ChannelType, PermissionFlagsBits, StringSelectMenuBuilder,
} = require('discord.js');
const { LEVELS, SUPPORT_RANKS, MOD_RANKS, GENERAL_MANAGEMENT_RANKS, TEAMS } = require('../constants');
const settings = require('../services/settings');
const { embed, COLORS, replyEphemeral, progressBar } = require('../utils');

const CHANNEL_META = {
  'staff-faq': { label: 'قاعدة المعرفة', emoji: '📚', desc: 'لوحة FAQ الثابتة' },
  'staff-updates': { label: 'تحديثات القوانين', emoji: '📢', desc: 'إشعارات تعديل FAQ والترقيات' },
  'leave-requests': { label: 'طلبات الإجازة', emoji: '🏖️', desc: 'مراجعة الإجازات بالأزرار' },
  'resignation-requests': { label: 'طلبات الاستقالة', emoji: '📤', desc: 'سري — للإدارة' },
  'staff-logs': { label: 'سجل العمليات', emoji: '🧾', desc: 'كل عملية يقوم بها البوت' },
  'performance-reports': { label: 'التقارير', emoji: '📊', desc: 'اليومي/الأسبوعي/الشهري' },
  'staff-alerts': { label: 'تنبيهات الغياب', emoji: '🚨', desc: 'غياب 96 ساعة + الخاملون' },
  'ticket-logs': { label: 'سجل التكتات', emoji: '🎫', desc: 'التكتات المسجلة' },
  'mod-logs': { label: 'سجل الإشراف', emoji: '🛡️', desc: 'الإجراءات الإشرافية' },
  'manager-review': { label: 'مراجعة الإدارة', emoji: '📈', desc: 'طلبات الترقية' },
  'ticket-source-logs': { label: 'مصدر سجل التكتات الخارجي', emoji: '🤖', desc: 'القناة التي يرسل فيها بوت التكتات رسالة الإغلاق — اختيارية' },
};
const ACTIVITY_META = {
  ticket: { label: 'قنوات التكتات', emoji: '🎫', weight: '50%' },
  staff: { label: 'قنوات الإدارة', emoji: '💬', weight: '25%' },
  moderation: { label: 'قنوات الإشراف', emoji: '🛡️', weight: '25%' },
};

// ===== الصفحة الرئيسية =====
function homePage() {
  const st = settings.status();
  const s = settings.load();
  const roleLine = (team, ranks) => ranks.map(r => `${s.roles[team][r.name] ? '🟢' : '⚪'} ${r.name}${s.roles[team][r.name] ? ` → <@&${s.roles[team][r.name]}>` : ''}`).join('\n');
  const chanLine = settings.CHANNEL_KEYS.map(k => `${s.channels[k] ? '🟢' : '⚪'} ${CHANNEL_META[k].emoji} ${CHANNEL_META[k].label}${s.channels[k] ? ` → <#${s.channels[k]}>` : ''}`).join('\n');
  const actLine = Object.entries(ACTIVITY_META).map(([k, m]) => `${m.emoji} ${m.label} (${m.weight}): ${s.activityChannels[k]?.length ? s.activityChannels[k].map(id => `<#${id}>`).join(' ') : '_غير محدد_'}`).join('\n');

  const e = embed('⚙️ إعداد Staff Manager', st.complete
    ? '✅ **الإعداد مكتمل!** البوت جاهز للعمل. يمكنك تعديل أي شيء من الأزرار أدناه.'
    : `أكمل الخطوات التالية لتشغيل البوت. كل خطوة قائمة اختيار — **بدون نسخ معرفات**.`, st.complete ? COLORS.success : COLORS.primary)
    .addFields(
      { name: `1️⃣ الرتب — ${st.rolesDone}/${st.rolesTotal}  ${progressBar(st.rolesDone, st.rolesTotal, 12)}`, value: `**🎧 الدعم الفني**\n${roleLine('support', SUPPORT_RANKS)}\n\n**🛡️ الإشراف**\n${roleLine('moderation', MOD_RANKS)}\n\n**🏛️ الإدارة العامة**\n${roleLine('general_management', GENERAL_MANAGEMENT_RANKS)}` },
      { name: `2️⃣ القنوات — ${st.channelsDone}/${st.channelsTotal}  ${progressBar(st.channelsDone, st.channelsTotal, 12)}`, value: chanLine },
      { name: '3️⃣ قنوات النشاط والتكتات الخارجية', value: actLine + `\n🤖 مصدر سجل التكتات: ${s.channels['ticket-source-logs'] ? `<#${s.channels['ticket-source-logs']}>` : '_غير محدد_'}\n_القنوات غير المحددة تُعتبر عامة (10%)، وقنوات \`ticket-…\` تُكتشف تلقائياً._` },
      { name: '4️⃣ صلاحية Server Manager', value: st.governanceConfigured ? `<@&${settings.governanceRoleId()}>` : '_اختيارية — إذا لم تحددها فمالك السيرفر فقط يستطيع تعيين الإدارة العامة_' },
    )
    .setFooter({ text: 'الإعدادات تُحفظ فوراً في قاعدة البيانات' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:roles:support:0').setLabel('رتب الدعم الفني').setEmoji('🎧').setStyle(st.missingRoles.some(m => m.team === 'support') ? ButtonStyle.Primary : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup:roles:moderation:0').setLabel('رتب الإشراف').setEmoji('🛡️').setStyle(st.missingRoles.some(m => m.team === 'moderation') ? ButtonStyle.Primary : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup:roles:general_management:0').setLabel('الإدارة العامة').setEmoji('🏛️').setStyle(st.missingRoles.some(m => m.team === 'general_management') ? ButtonStyle.Primary : ButtonStyle.Success),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:channels:0').setLabel('تحديد القنوات').setEmoji('📁').setStyle(st.missingChannels.length ? ButtonStyle.Primary : ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup:autocreate').setLabel('إنشاء القنوات الناقصة تلقائياً').setEmoji('✨').setStyle(ButtonStyle.Secondary).setDisabled(!st.missingChannels.length),
    new ButtonBuilder().setCustomId('setup:activity').setLabel('قنوات النشاط').setEmoji('📡').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:ticket-source').setLabel('مصدر سجل التكتات').setEmoji('🤖').setStyle(st.ticketSourceConfigured ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:governance').setLabel('Server Manager').setEmoji('👑').setStyle(st.governanceConfigured ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  return { embeds: [e], components: [row1, row2] };
}

// ===== صفحة الرتب: رتبة واحدة في كل خطوة مع قائمة اختيار الرتب =====
function rolesPage(team, idx) {
  const ranks = team === 'support' ? SUPPORT_RANKS : team === 'moderation' ? MOD_RANKS : GENERAL_MANAGEMENT_RANKS;
  idx = Math.max(0, Math.min(idx, ranks.length - 1));
  const r = ranks[idx];
  const cur = settings.roleId(team, r.name);
  const e = embed(`${team === 'support' ? '🎧' : team === 'moderation' ? '🛡️' : '🏛️'} رتب ${TEAMS[team]} — ${idx + 1}/${ranks.length}`,
    `اختر رتبة الديسكورد المقابلة لـ:\n\n# ${r.name}\n**الفئة:** ${r.category}${r.perms ? `\n**الصلاحيات:** ${r.perms}` : ''}${r.handlesTickets === false ? '\n_لا يستلم تكتات_' : ''}\n\n**الحالي:** ${cur ? `<@&${cur}>` : '_غير محدد_'}`, COLORS.info)
    .setFooter({ text: `${progressBar(idx + 1, ranks.length, ranks.length)}  •  اختر من القائمة وسينتقل للرتبة التالية تلقائياً` });
  const select = new RoleSelectMenuBuilder().setCustomId(`setup:pickrole:${team}:${idx}`).setPlaceholder(`🔽 اختر رتبة ${r.name}`).setMinValues(1).setMaxValues(1);
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup:roles:${team}:${idx - 1}`).setLabel('السابق').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(idx === 0),
    new ButtonBuilder().setCustomId(`setup:roles:${team}:${idx + 1}`).setLabel('التالي').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(idx === ranks.length - 1),
    new ButtonBuilder().setCustomId(`setup:autoroles:${team}`).setLabel('مطابقة تلقائية بالاسم').setEmoji('🪄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:home').setLabel('الرئيسية').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(select), nav] };
}

// ===== صفحة القنوات =====
function channelsPage(idx) {
  const keys = settings.CHANNEL_KEYS;
  idx = Math.max(0, Math.min(idx, keys.length - 1));
  const k = keys[idx];
  const m = CHANNEL_META[k];
  const cur = settings.channelId(k);
  const e = embed(`📁 القنوات — ${idx + 1}/${keys.length}`,
    `اختر القناة المخصصة لـ:\n\n# ${m.emoji} ${m.label}\n\`#${k}\` — ${m.desc}\n\n**الحالي:** ${cur ? `<#${cur}>` : '_غير محدد_'}`, COLORS.info)
    .setFooter({ text: `${progressBar(idx + 1, keys.length, keys.length)}  •  اختر من القائمة وسينتقل للقناة التالية تلقائياً` });
  const select = new ChannelSelectMenuBuilder().setCustomId(`setup:pickchannel:${idx}`).setPlaceholder(`🔽 اختر قناة ${m.label}`).addChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1);
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup:channels:${idx - 1}`).setLabel('السابق').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(idx === 0),
    new ButtonBuilder().setCustomId(`setup:channels:${idx + 1}`).setLabel('التالي').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(idx === keys.length - 1),
    new ButtonBuilder().setCustomId('setup:autochannels').setLabel('مطابقة تلقائية بالاسم').setEmoji('🪄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:home').setLabel('الرئيسية').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(select), nav] };
}

// ===== صفحة قنوات النشاط =====
function activityPage() {
  const s = settings.activityChannels();
  const e = embed('📡 قنوات النشاط', 'حدد القنوات أو **الكاتيجوري** لكل نوع (يمكن اختيار حتى 10). كل ما عداها يُحسب عاماً بوزن 10%.\n\n' +
    Object.entries(ACTIVITY_META).map(([k, m]) => `${m.emoji} **${m.label}** (${m.weight}): ${s[k]?.length ? s[k].map(id => `<#${id}>`).join(' ') : '_غير محدد_'}`).join('\n'), COLORS.info);
  const rows = Object.entries(ACTIVITY_META).map(([k, m]) => new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId(`setup:pickactivity:${k}`).setPlaceholder(`${m.emoji} ${m.label} (${m.weight})`)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildCategory).setMinValues(0).setMaxValues(10).setDefaultChannels(...(s[k] || []).slice(0, 10))));
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:home').setLabel('الرئيسية').setEmoji('🏠').setStyle(ButtonStyle.Secondary)));
  return { embeds: [e], components: rows };
}

// ===== إعداد مصدر سجل التكتات الخارجي =====
function ticketSourcePage() {
  const cur = settings.channelId('ticket-source-logs');
  const botId = settings.ticketLogBotId();
  const e = embed('🤖 مصدر سجل التكتات الخارجي',
    `اختر القناة التي يرسل فيها بوت التكتات رسالة الإغلاق (مثل: \`close-2127\`).\n\n**القناة الحالية:** ${cur ? `<#${cur}>` : '_غير محددة_'}\n**معرف البوت (اختياري):** ${botId ? `\`${botId}\`` : '_أي بوت داخل القناة_' }\n\nبعد تحديدها سيقرأ Staff Manager الرسالة تلقائياً ويحتسب التكت والنقاط. لا يحتاج البوتان إلى التكامل مع بعضهما، ولا يحتاج الدعم لاستخدام \`/log-ticket\`.`, COLORS.info);
  const select = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('setup:pickticketsource').setPlaceholder('🔽 اختر قناة سجل بوت التكتات').addChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1),
  );
  const nav = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:home').setLabel('الرئيسية').setEmoji('🏠').setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: [select, nav] };
}

// ===== إعداد رتبة Server Manager =====
function governancePage() {
  const cur = settings.governanceRoleId();
  const e = embed('👑 صلاحية Server Manager',
    `اختر رتبة مالكي السيرفر/Server Manager المسموح لها بتعيين الإدارة العامة.\n\n**الحالي:** ${cur ? `<@&${cur}>` : '_غير محدد_'}\n\nمالك السيرفر يستطيع دائماً استخدام الأمر. **General Manager الحالي** يستطيع أيضاً تعيين أو إزالة أعضاء الإدارة العامة. Co General Manager لا يملك هذه الصلاحية.`, COLORS.info);
  const select = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup:pickgovernance').setPlaceholder('🔽 اختر رتبة Server Manager').setMinValues(1).setMaxValues(1));
  const nav = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:home').setLabel('الرئيسية').setEmoji('🏠').setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: [select, nav] };
}

// ===== المطابقة التلقائية =====
const norm = (s) => s.toLowerCase().replace(/[\s_\-]+/g, '');
function autoMatchRoles(guild, team) {
  const ranks = team === 'support' ? SUPPORT_RANKS : team === 'moderation' ? MOD_RANKS : GENERAL_MANAGEMENT_RANKS;
  const matched = [];
  for (const r of ranks) {
    const role = guild.roles.cache.find(x => norm(x.name) === norm(r.name)) || guild.roles.cache.find(x => norm(x.name).includes(norm(r.name)) && !ranks.some(o => o !== r && norm(x.name) === norm(o.name)));
    if (role) { settings.setRole(team, r.name, role.id); matched.push(`${r.name} → <@&${role.id}>`); }
  }
  return matched;
}
function autoMatchChannels(guild) {
  const matched = [];
  for (const k of settings.CHANNEL_KEYS) {
    const ch = guild.channels.cache.find(c => c.type === ChannelType.GuildText && (norm(c.name) === norm(k) || norm(c.name).includes(norm(k))));
    if (ch) { settings.setChannel(k, ch.id); matched.push(`${CHANNEL_META[k].emoji} ${k} → <#${ch.id}>`); }
  }
  return matched;
}

async function autoCreate(guild, botMember) {
  const st = settings.status();
  if (!st.missingChannels.length) return { created: [], category: null };
  let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && /staff.?manager|إدارة الفريق/i.test(c.name));
  const staffRoleIds = [...Object.values(settings.roles().support), ...Object.values(settings.roles().moderation), ...Object.values(settings.roles().general_management)].filter(Boolean);
  const managementIds = [settings.roleId('support', 'Support Office'), settings.roleId('support', 'Boss'), settings.roleId('moderation', 'Head Of Moderators'), settings.roleId('general_management', 'Co General Manager'), settings.roleId('general_management', 'General Manager')].filter(Boolean);
  const overwrites = (allowedIds) => [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] },
    ...allowedIds.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel] })),
  ];
  if (!category) category = await guild.channels.create({ name: '📋 Staff Manager', type: ChannelType.GuildCategory, permissionOverwrites: overwrites(staffRoleIds) });
  const PRIVATE = ['resignation-requests', 'manager-review', 'leave-requests', 'performance-reports', 'staff-alerts', 'staff-logs'];
  const created = [];
  for (const k of st.missingChannels) {
    const ch = await guild.channels.create({
      name: `${CHANNEL_META[k].emoji}┃${k}`, type: ChannelType.GuildText, parent: category.id, topic: CHANNEL_META[k].desc,
      permissionOverwrites: overwrites(PRIVATE.includes(k) ? (managementIds.length ? managementIds : staffRoleIds) : staffRoleIds),
    });
    settings.setChannel(k, ch.id);
    created.push(`<#${ch.id}>`);
  }
  return { created, category };
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('setup').setDescription('⚙️ إعداد البوت: الرتب والقنوات (بقوائم اختيار — بدون معرفات)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
      level: LEVELS.STAFF, bypassStaffCheck: true, adminOnly: true,
      async execute(i) { return i.reply({ ...homePage(), ephemeral: true }); },
    },
  ],

  components: {
    'setup:home': async (i) => i.update(homePage()),
    'setup:roles': async (i, [team, idx]) => i.update(rolesPage(team, Number(idx))),
    'setup:channels': async (i, [idx]) => i.update(channelsPage(Number(idx))),
    'setup:activity': async (i) => i.update(activityPage()),
    'setup:ticket-source': async (i) => i.update(ticketSourcePage()),
    'setup:governance': async (i) => i.update(governancePage()),

    'setup:pickrole': async (i, [team, idx]) => {
      const ranks = team === 'support' ? SUPPORT_RANKS : team === 'moderation' ? MOD_RANKS : GENERAL_MANAGEMENT_RANKS;
      const n = Number(idx);
      const roleId = i.values[0];
      const role = i.guild.roles.cache.get(roleId);
      if (role && i.guild.members.me && role.position >= i.guild.members.me.roles.highest.position) {
        await i.reply({ embeds: [embed(null, `⚠️ تم الحفظ، لكن رتبة **${role.name}** أعلى من رتبة البوت — لن يستطيع تعديلها عند الترقية/الاستقالة. ارفع رتبة البوت فوقها.`, COLORS.warning)], ephemeral: true });
        settings.setRole(team, ranks[n].name, roleId);
        return i.message.edit(n < ranks.length - 1 ? rolesPage(team, n + 1) : homePage());
      }
      settings.setRole(team, ranks[n].name, roleId);
      return i.update(n < ranks.length - 1 ? rolesPage(team, n + 1) : homePage());
    },
    'setup:pickchannel': async (i, [idx]) => {
      const n = Number(idx);
      settings.setChannel(settings.CHANNEL_KEYS[n], i.values[0]);
      return i.update(n < settings.CHANNEL_KEYS.length - 1 ? channelsPage(n + 1) : homePage());
    },
    'setup:pickactivity': async (i, [type]) => {
      settings.setActivity(type, i.values);
      return i.update(activityPage());
    },
    'setup:pickticketsource': async (i) => {
      settings.setChannel('ticket-source-logs', i.values[0]);
      return i.update(ticketSourcePage());
    },
    'setup:pickgovernance': async (i) => {
      settings.setGovernanceRole(i.values[0]);
      return i.update(governancePage());
    },
    'setup:autoroles': async (i, [team]) => {
      const matched = autoMatchRoles(i.guild, team);
      await i.update(rolesPage(team, 0));
      return i.followUp({ embeds: [embed('🪄 المطابقة التلقائية', matched.length ? `تم ربط **${matched.length}** رتبة:\n${matched.join('\n')}\n\nراجعها وعدّل ما تحتاج.` : 'لم أجد رتباً بأسماء مطابقة. اخترها يدوياً من القائمة.', matched.length ? COLORS.success : COLORS.warning)], ephemeral: true });
    },
    'setup:autochannels': async (i) => {
      const matched = autoMatchChannels(i.guild);
      await i.update(channelsPage(0));
      return i.followUp({ embeds: [embed('🪄 المطابقة التلقائية', matched.length ? `تم ربط **${matched.length}** قناة:\n${matched.join('\n')}` : 'لم أجد قنوات بأسماء مطابقة. اخترها يدوياً أو استخدم **الإنشاء التلقائي**.', matched.length ? COLORS.success : COLORS.warning)], ephemeral: true });
    },
    'setup:autocreate': async (i) => {
      if (!i.guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) return replyEphemeral(i, '❌ البوت يحتاج صلاحية **إدارة القنوات** لإنشائها تلقائياً.', COLORS.danger);
      await i.deferUpdate();
      try {
        const { created, category } = await autoCreate(i.guild, i.guild.members.me);
        await i.editReply(homePage());
        return i.followUp({ embeds: [embed('✨ تم إنشاء القنوات', `أُنشئت **${created.length}** قناة داخل الكاتيجوري **${category?.name}**:\n${created.join(' ')}\n\n🔒 القنوات الحساسة (الاستقالات، المراجعة، التقارير…) مرئية للإدارة العليا فقط${settings.status().anyRole ? '' : ' — **حدد الرتب أولاً** ثم عدّل صلاحيات القنوات'}.`, COLORS.success)], ephemeral: true });
      } catch (e) {
        return i.followUp({ embeds: [embed('❌ فشل الإنشاء', e.message, COLORS.danger)], ephemeral: true });
      }
    },
  },
  homePage,
};
