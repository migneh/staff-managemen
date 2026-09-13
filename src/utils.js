'use strict';
const { EmbedBuilder } = require('discord.js');
const config = require('./config');
const settings = () => require('./services/settings');

const COLORS = { primary: 0x5865f2, success: 0x57f287, warning: 0xfee75c, danger: 0xed4245, info: 0x3498db, gray: 0x99aab5 };

function embed(title, description, color = COLORS.primary) {
  const e = new EmbedBuilder().setColor(color).setTimestamp();
  if (title) e.setTitle(title);
  if (description) e.setDescription(description);
  return e;
}

/** إمبد يحمل هوية المستخدم (صورة + اسم) — للتقارير والسجلات */
function userEmbed(user, title, description, color = COLORS.primary) {
  const e = embed(title, description, color);
  if (user) e.setAuthor({ name: user.displayName || user.username || user.tag, iconURL: typeof user.displayAvatarURL === 'function' ? user.displayAvatarURL() : undefined }).setThumbnail(typeof user.displayAvatarURL === 'function' ? user.displayAvatarURL({ size: 128 }) : null);
  return e;
}

const ok = (i, text) => replyEphemeral(i, `✅ ${text}`, COLORS.success);
const fail = (i, text) => replyEphemeral(i, `❌ ${text}`, COLORS.danger);
const divider = '━━━━━━━━━━━━━━━━━━━━';
function scoreColor(score) { return score >= 85 ? 0x2ecc71 : score >= 70 ? 0x3498db : score >= 50 ? 0xf1c40f : 0xe74c3c; }
function scoreEmoji(score) { return score >= 85 ? '🟢' : score >= 70 ? '🔵' : score >= 50 ? '🟡' : '🔴'; }

function nowIso() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(dateStr, days) {
  const d = new Date(dateStr + (dateStr.length === 10 ? 'T00:00:00Z' : ''));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function monthsSince(isoDate) {
  const ms = Date.now() - new Date(isoDate.replace(' ', 'T') + (isoDate.length <= 19 ? 'Z' : '')).getTime();
  return ms / (30.44 * 86400000);
}
function hoursSince(isoDate) {
  if (!isoDate) return Infinity;
  return (Date.now() - new Date(isoDate.replace(' ', 'T') + 'Z').getTime()) / 3600000;
}
function discordTs(dateStr, style = 'D') {
  const t = Math.floor(new Date(dateStr.replace(' ', 'T') + (dateStr.length <= 19 ? 'Z' : '')).getTime() / 1000);
  return `<t:${t}:${style}>`;
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n - 1) + '…' : s || ''; }

async function getChannel(client, key) {
  const id = settings().channelId(key);
  if (!id) return null;
  try { return await client.channels.fetch(id); } catch { return null; }
}

async function sendToChannel(client, key, payload) {
  const ch = await getChannel(client, key);
  if (!ch) return null;
  try { return await ch.send(payload); } catch (e) { console.error(`فشل الإرسال إلى #${key}:`, e.message); return null; }
}

async function log(client, title, description, color = COLORS.gray) {
  return sendToChannel(client, 'staff-logs', { embeds: [embed(title, description, color)] });
}

async function dm(client, userId, payload) {
  try {
    const user = await client.users.fetch(userId);
    await user.send(payload);
    return true;
  } catch { return false; }
}

async function replyEphemeral(interaction, content, color = COLORS.info) {
  const payload = { embeds: [embed(null, content, color)], ephemeral: true };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

function progressBar(value, max, size = 10) {
  const filled = Math.round(Math.min(Math.max(value, 0) / (max || 1), 1) * size);
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

module.exports = { COLORS, embed, userEmbed, ok, fail, divider, scoreColor, scoreEmoji, nowIso, today, addDays, isValidDate, daysBetween, monthsSince, hoursSince, discordTs, truncate, getChannel, sendToChannel, log, dm, replyEphemeral, progressBar };
