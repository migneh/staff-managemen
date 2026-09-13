'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS } = require('../constants');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, truncate, discordTs } = require('../utils');

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('audit-log').setDescription('عرض سجل العمليات الحساسة')
        .addUserOption(o => o.setName('user').setDescription('تصفية حسب العضو — اختياري').setRequired(false))
        .addIntegerOption(o => o.setName('limit').setDescription('عدد السجلات (1-25)').setMinValue(1).setMaxValue(25).setRequired(false)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const user = i.options.getUser('user');
        const rows = audit.list({ targetId: user?.id, limit: i.options.getInteger('limit') || 15 });
        if (!rows.length) return replyEphemeral(i, 'لا توجد سجلات مطابقة.', COLORS.gray);
        const lines = rows.map(r => {
          const details = audit.parseDetails(r.details);
          const summary = typeof details === 'string' ? details : details ? Object.entries(details).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(' • ') : '';
          return `**#${r.id} ${r.action}** • ${discordTs(r.created_at, 'R')}\nالمنفذ: ${r.actor_id ? `<@${r.actor_id}>` : 'النظام'}${r.target_id ? ` • الهدف: <@${r.target_id}>` : ''}${summary ? `\n╰ ${truncate(summary, 220)}` : ''}`;
        });
        return i.reply({ embeds: [embed('🧾 سجل العمليات الحساسة', lines.join('\n\n'), COLORS.info)], ephemeral: true });
      },
    },
  ],
  components: {},
};
