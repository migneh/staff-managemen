'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS } = require('../constants');
const backup = require('../services/backup');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral } = require('../utils');

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('backup').setDescription('إنشاء نسخة احتياطية آمنة من بيانات البوت'),
      level: LEVELS.STAFF,
      serverManagerOnly: true,
      async execute(i) {
        await i.deferReply({ ephemeral: true });
        try {
          const file = await backup.createBackup({ reason: `manual-${i.user.id}` });
          audit.record({ action: 'database_backup', actorId: i.user.id, details: { file }, channelId: i.channelId });
          return i.editReply({ embeds: [embed('✅ تم إنشاء النسخة الاحتياطية', `تم حفظ نسخة جديدة بأمان.\n\`${file.split('/').pop()}\`\n\nتُحفظ آخر النسخ حسب إعداد **BACKUP_KEEP**.`, COLORS.success)] });
        } catch (e) {
          return i.editReply({ embeds: [embed('❌ فشل النسخ الاحتياطي', e.message, COLORS.danger)] });
        }
      },
    },
  ],
  components: {},
};
