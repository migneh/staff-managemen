'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'config.json');
const examplePath = path.join(__dirname, '..', 'config.example.json');

let fileConfig = {};
if (fs.existsSync(configPath)) {
  fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} else if (fs.existsSync(examplePath)) {
  console.warn('⚠️  لم يتم العثور على config.json — سيتم استخدام config.example.json (المعرفات وهمية).');
  fileConfig = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
}

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'staff.db'),
  roles: fileConfig.roles || { support: {}, moderation: {} },
  channels: fileConfig.channels || {},
  activityChannels: fileConfig.activityChannels || { ticket: [], staff: [], moderation: [] },
  leave: { maxDays: 30, maxConcurrent: 3, ...(fileConfig.leave || {}) },
  resignation: { noticeDays: 3, ...(fileConfig.resignation || {}) },
};
