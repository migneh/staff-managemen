'use strict';
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LEVELS, INACTIVE_STATUSES } = require('../constants');
const { getDb } = require('../database');
const points = require('../services/points');
const staffService = require('../services/staff');
const settings = require('../services/settings');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, sendToChannel, dm, today } = require('../utils');

function nominationEmbed(row, color = COLORS.warning) {
  return embed(`🏆 ترشيح تقدير #${row.id}`, `من <@${row.nominator_id}> إلى <@${row.target_id}>\n\n**السبب:** ${row.reason}\n\nالحالة: **${row.status === 'pending' ? 'بانتظار اعتماد الإدارة' : row.status === 'approved' ? 'معتمد' : 'مرفوض'}**`, color)
    .setFooter({ text: 'النقاط لا تُمنح إلا بعد اعتماد إداري.' });
}

function reviewRow(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`recognition:approve:${id}`).setLabel('اعتماد +5').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`recognition:reject:${id}`).setLabel('رفض').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );
}

function winsChannel() {
  return settings.channelId('staff-wins') ? 'staff-wins' : 'staff-updates';
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('shoutout').setDescription('ترشيح زميل لتقدير موثق — يعتمد من الإدارة')
        .addUserOption(o => o.setName('user').setDescription('الزميل').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('ما الذي يستحق التقدير؟').setRequired(true).setMaxLength(400)),
      level: LEVELS.STAFF,
      async execute(i) {
        const user = i.options.getUser('user');
        if (user.id === i.user.id) return replyEphemeral(i, '❌ اختر زميلاً آخر — لا يمكن ترشيح نفسك.', COLORS.danger);
        const target = staffService.get(user.id);
        if (!target || INACTIVE_STATUSES.includes(target.status) || target.status === 'probation') return replyEphemeral(i, '❌ العضو ليس إداريًا نشطاً مؤهلاً للترشيح.', COLORS.danger);
        const todayCount = getDb().prepare("SELECT COUNT(*) c FROM recognition_nominations WHERE nominator_id = ? AND date(created_at, 'localtime') = ?").get(i.user.id, today()).c;
        if (todayCount >= 3) return replyEphemeral(i, '❌ وصلت إلى حد 3 ترشيحات اليوم.', COLORS.danger);
        const duplicate = getDb().prepare("SELECT id FROM recognition_nominations WHERE nominator_id = ? AND target_id = ? AND status = 'pending'").get(i.user.id, user.id);
        if (duplicate) return replyEphemeral(i, `ℹ️ لديك ترشيح مفتوح مسبقاً لهذا الزميل (#${duplicate.id}).`, COLORS.info);
        const reason = i.options.getString('reason').trim();
        const result = getDb().prepare('INSERT INTO recognition_nominations (nominator_id, target_id, reason) VALUES (?, ?, ?)').run(i.user.id, user.id, reason);
        const row = getDb().prepare('SELECT * FROM recognition_nominations WHERE id = ?').get(result.lastInsertRowid);
        audit.record({ action: 'recognition_nominated', actorId: i.user.id, targetId: user.id, details: { nominationId: row.id, reason }, channelId: i.channelId });
        const channel = winsChannel();
        await sendToChannel(i.client, channel, { embeds: [nominationEmbed(row)], components: [reviewRow(row.id)] });
        return replyEphemeral(i, `✅ تم ترشيح <@${user.id}> للتقدير (#${row.id}). ستعتمد الإدارة الترشيح قبل منح النقاط.`, COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('review-shoutouts').setDescription('مراجعة ترشيحات تقدير الزملاء')
        .addStringOption(o => o.setName('status').setDescription('الحالة').addChoices({ name: 'مفتوحة', value: 'pending' }, { name: 'كل الحالات', value: 'all' })),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const all = i.options.getString('status') === 'all';
        const rows = getDb().prepare(`SELECT * FROM recognition_nominations ${all ? '' : "WHERE status = 'pending'"} ORDER BY id DESC LIMIT 10`).all();
        if (!rows.length) return replyEphemeral(i, '✅ لا توجد ترشيحات تقدير.', COLORS.success);
        return i.reply({ embeds: rows.slice(0, 10).map(nominationEmbed), components: rows.filter(r => r.status === 'pending').slice(0, 5).map(r => reviewRow(r.id)), ephemeral: true });
      },
    },
  ],
  components: {
    'recognition:approve': async (i, [id]) => decide(i, id, 'approved'),
    'recognition:reject': async (i, [id]) => decide(i, id, 'rejected'),
  },
};

async function decide(i, id, status) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM recognition_nominations WHERE id = ? AND status = 'pending'").get(Number(id));
  if (!row) return replyEphemeral(i, '❌ الترشيح غير موجود أو تمت مراجعته.', COLORS.danger);
  let awarded = 0;
  if (status === 'approved') {
    const target = staffService.get(row.target_id);
    if (!target || INACTIVE_STATUSES.includes(target.status)) return replyEphemeral(i, '❌ العضو لم يعد نشطاً، لا يمكن اعتماد الترشيح.', COLORS.danger);
    awarded = points.add(row.target_id, 'shoutout', target.team, { refType: 'recognition', refId: row.id, addedBy: i.user.id });
  }
  db.prepare('UPDATE recognition_nominations SET status = ?, reviewed_by = ?, reviewed_at = datetime(\'now\'), points_awarded = ? WHERE id = ?')
    .run(status, i.user.id, awarded, row.id);
  const updated = db.prepare('SELECT * FROM recognition_nominations WHERE id = ?').get(row.id);
  audit.record({ action: `recognition_${status}`, actorId: i.user.id, targetId: row.target_id, details: { nominationId: row.id, points: awarded }, channelId: i.channelId });
  await i.update({ embeds: [nominationEmbed(updated, status === 'approved' ? COLORS.success : COLORS.gray)], components: [] });
  if (status === 'approved') await dm(i.client, row.target_id, { embeds: [embed('🏆 تقدير من زميل', `<@${row.nominator_id}> رشحك تقديراً لـ:\n\n${row.reason}\n\nمنحتك الإدارة **+${awarded} نقاط**.`, COLORS.success)] });
  const channel = winsChannel();
  await sendToChannel(i.client, channel, { embeds: [nominationEmbed(updated, status === 'approved' ? COLORS.success : COLORS.gray)] });
  return null;
}
