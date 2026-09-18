'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS, NOTE_TYPES, WARNING_TYPES, COOLDOWNS, TEAMS, STATUS } = require('../constants');
const { getDb } = require('../database');
const points = require('../services/points');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, dm, log, discordTs } = require('../utils');

function recordEmbed(userId, { includeSecret }) {
  const db = getDb();
  const notes = db.prepare(`SELECT * FROM staff_notes WHERE user_id = ? ${includeSecret ? '' : 'AND is_secret = 0'} ORDER BY id DESC LIMIT 10`).all(userId);
  const warns = db.prepare('SELECT * FROM warnings WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(userId);
  const s = staffService.get(userId);
  const e = embed(`📁 سجل الإداري ${userId}`, null, COLORS.info)
    .setDescription(`👤 <@${userId}>${s ? ` • ${s.rank} • ${TEAMS[s.team] || s.team}` : ''}\n🎯 نقاط الترقية: **${points.total(userId)}**`);
  // ===== تاريخ الرتب: من رقّى مَن ومتى (ROADMAP 2.1) =====
  const RANK_CHANGE = {
    promote: '⬆️ ترقية', demote: '⬇️ تنزيل', reassign: '↔️ إعادة تعيين',
    remove: '🚪 إزالة', left_guild: '👋 مغادرة السيرفر',
  };
  const rankRows = staffService.rankHistory(userId, 5);
  if (rankRows.length) {
    e.addFields({
      name: '📜 تاريخ الرتب',
      value: rankRows.map(r => {
        const to = r.change_type === 'remove' || r.change_type === 'left_guild' ? r.from_rank : r.to_rank;
        const from = r.from_rank && r.from_rank !== to ? `${r.from_rank} → ` : '';
        const who = r.actor_id ? ` • <@${r.actor_id}>` : '';
        return `${RANK_CHANGE[r.change_type] || r.change_type}: ${from}**${to || '—'}** • ${discordTs(r.created_at, 'd')}${who}`;
      }).join('\n').slice(0, 1024),
    });
  }
  e.addFields({
    name: `⚠️ الإنذارات (${warns.length})`,
    value: warns.length ? warns.map(w => `${WARNING_TYPES[w.warning_type]?.emoji} **${WARNING_TYPES[w.warning_type]?.label}** — ${w.reason} • ${discordTs(w.created_at, 'd')} • <@${w.issued_by}>`).join('\n').slice(0, 1024) : 'لا يوجد',
  }, {
    name: `📝 الملاحظات (${notes.length})`,
    value: notes.length ? notes.map(n => `${NOTE_TYPES[n.note_type]?.emoji}${n.is_secret ? '🔒' : ''} ${n.content} • ${discordTs(n.created_at, 'd')}`).join('\n').slice(0, 1024) : 'لا يوجد',
  });
  return e;
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('add-note').setDescription('إضافة ملاحظة على إداري')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('type').setDescription('النوع').setRequired(true).addChoices({ name: '🟢 إيجابية (+5)', value: 'positive' }, { name: '🟡 سلبية (-10)', value: 'negative' }))
        .addStringOption(o => o.setName('content').setDescription('نص الملاحظة').setRequired(true).setMaxLength(500))
        .addBooleanOption(o => o.setName('secret').setDescription('ملاحظة سرية (للإدارة فقط)')),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        const user = i.options.getUser('user');
        const type = i.options.getString('type');
        const content = i.options.getString('content');
        const secret = i.options.getBoolean('secret') ? 1 : 0;
        const target = staffService.get(user.id);
        if (!target) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        const res = getDb().prepare('INSERT INTO staff_notes (user_id, note_type, content, is_secret, added_by) VALUES (?, ?, ?, ?, ?)').run(user.id, type, content, secret, i.user.id);
        const pts = points.add(user.id, type === 'positive' ? 'positive_note' : 'negative_note', target.team, { refType: 'note', refId: res.lastInsertRowid, addedBy: i.user.id });
        audit.record({ action: 'staff_note_added', actorId: i.user.id, targetId: user.id, details: { type, secret: !!secret, rowId: res.lastInsertRowid }, channelId: i.channelId });
        const def = NOTE_TYPES[type];
        await replyEphemeral(i, `${def.emoji} تمت إضافة ${def.label} على <@${user.id}> (${pts > 0 ? '+' : ''}${pts} نقطة)${secret ? ' 🔒' : ''}.`, COLORS.success);
        if (!secret) await dm(i.client, user.id, { embeds: [embed(`${def.emoji} ${def.label} جديدة`, `${content}\n\n**النقاط:** ${pts > 0 ? '+' : ''}${pts}`, type === 'positive' ? COLORS.success : COLORS.warning)] });
        return log(i.client, `${def.emoji} ${def.label}${secret ? ' 🔒' : ''}`, `على <@${user.id}> بواسطة <@${i.user.id}>\n${content}`, COLORS.gray);
      },
    },
    {
      data: new SlashCommandBuilder().setName('warn').setDescription('إصدار إنذار على إداري')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('type').setDescription('نوع الإنذار').setRequired(true)
          .addChoices(...Object.entries(WARNING_TYPES).map(([v, d]) => ({ name: `${d.emoji} ${d.label} (${d.points})`, value: v }))))
        .addStringOption(o => o.setName('reason').setDescription('السبب').setRequired(true).setMaxLength(500)),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        const user = i.options.getUser('user');
        const type = i.options.getString('type');
        const reason = i.options.getString('reason');
        const def = WARNING_TYPES[type];
        if (i.staffLevel < def.minLevel) return replyEphemeral(i, `❌ ${def.label} يتطلب صلاحية أعلى.`, COLORS.danger);
        const target = staffService.get(user.id);
        if (!target) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        if (user.id === i.user.id) return replyEphemeral(i, '❌ لا يمكنك إنذار نفسك.', COLORS.danger);

        const res = getDb().prepare('INSERT INTO warnings (user_id, warning_type, reason, issued_by) VALUES (?, ?, ?, ?)').run(user.id, type, reason, i.user.id);
        const pts = points.add(user.id, type === 'verbal' ? 'verbal_warning' : 'formal_warning', target.team, { refType: 'warning', refId: res.lastInsertRowid, addedBy: i.user.id });
        audit.record({ action: 'staff_warning_issued', actorId: i.user.id, targetId: user.id, details: { type, reason, rowId: res.lastInsertRowid }, channelId: i.channelId });
        let extra = '';
        if (def.suspend) {
          // إيقاف بتاريخ انتهاء واضح: 60 يوماً لتجميد الترقية، ثم رفع تلقائي للصلاحيات
          const until = points.setCooldown(user.id, 'suspended', COOLDOWNS.suspended);
          staffService.suspend(user.id, until);
          extra = `\n⛔ تم الإيقاف + تجميد الترقية حتى ${until}\n↩️ يُرفع الإيقاف تلقائياً في ${until} (أو يدوياً بـ \`/unsuspend\`)`;
        } else if (def.freezeDays) { const until = points.setCooldown(user.id, 'warning', def.freezeDays); extra = `\n🧊 تجميد الترقية حتى ${until}`; }

        await replyEphemeral(i, `${def.emoji} تم إصدار **${def.label}** على <@${user.id}> (${pts} نقطة).${extra}`, COLORS.warning);
        await dm(i.client, user.id, { embeds: [embed(`${def.emoji} ${def.label}`, `**السبب:** ${reason}\n**النقاط:** ${pts}${extra}\n\nبواسطة: <@${i.user.id}>`, COLORS.danger)] });
        return log(i.client, `${def.emoji} ${def.label}`, `على <@${user.id}> بواسطة <@${i.user.id}>\n${reason}${extra}`, COLORS.danger);
      },
    },
    {
      data: new SlashCommandBuilder().setName('staff-record').setDescription('عرض سجل إداري (إنذارات وملاحظات)')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true)),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        const user = i.options.getUser('user');
        return i.reply({ embeds: [recordEmbed(user.id, { includeSecret: i.staffLevel >= LEVELS.MANAGEMENT })], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('my-record').setDescription('عرض سجلك الشخصي'),
      level: LEVELS.STAFF,
      async execute(i) { return i.reply({ embeds: [recordEmbed(i.user.id, { includeSecret: false })], ephemeral: true }); },
    },
    {
      data: new SlashCommandBuilder().setName('unsuspend').setDescription('رفع الإيقاف عن إداري قبل انتهاء مدته (Boss أو أعلى)')
        .addUserOption(o => o.setName('user').setDescription('الإداري الموقوف').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('سبب رفع الإيقاف').setRequired(true).setMaxLength(300)),
      level: LEVELS.BOSS,
      async execute(i) {
        const user = i.options.getUser('user');
        const reason = i.options.getString('reason');
        const target = staffService.get(user.id);
        if (!target) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        if (target.status !== 'suspended') {
          return replyEphemeral(i, `❌ <@${user.id}> ليس موقوفاً حالياً (الحالة: **${STATUS[target.status] || target.status}**).`, COLORS.danger);
        }
        staffService.unsuspend(user.id);
        audit.record({ action: 'staff_unsuspended', actorId: i.user.id, targetId: user.id, details: { reason, wasUntil: target.suspended_until || null }, channelId: i.channelId });
        await replyEphemeral(i, `✅ تم رفع الإيقاف عن <@${user.id}> وعاد إلى الحالة النشطة.\n_تبقى فترة تبريد الترقية كما هي حتى انتهائها._`, COLORS.success);
        await dm(i.client, user.id, { embeds: [embed('✅ رُفع الإيقاف', `تمت إعادة تفعيل حسابك الإداري.\n**السبب:** ${reason}\n\nنعتذر عن أي إزعاج، ومرحباً بعودتك.`, COLORS.success)] });
        return log(i.client, '↩️ رفع إيقاف', `<@${user.id}> بواسطة <@${i.user.id}>\n${reason}`, COLORS.success);
      },
    },
  ],
  components: {},
};
