'use strict';
/**
 * إعدادات السيرفر (الرتب والقنوات) — تُخزن في قاعدة البيانات وتُضبط عبر /setup.
 * config.json يبقى مصدراً احتياطياً (اختياري).
 */
const { getDb } = require('../database');
const fileConfig = require('../config');
const { SUPPORT_RANKS, MOD_RANKS, GENERAL_MANAGEMENT_RANKS } = require('../constants');

let cache = null;

function ensureTable() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
}

function load() {
  if (cache) return cache;
  ensureTable();
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const kv = Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)]));
  const fileRoles = fileConfig.roles || {};
  cache = {
    roles: {
      support: { ...(fileRoles.support || {}) },
      moderation: { ...(fileRoles.moderation || {}) },
      general_management: { ...(fileRoles.general_management || {}) },
      governance: { ...(fileRoles.governance || {}) },
      system: { ...(fileRoles.system || {}) },
    },
    channels: { ...(fileConfig.channels || {}) },
    activityChannels: { ticket: [], staff: [], moderation: [], ...(fileConfig.activityChannels || {}) },
    ticketLogBotId: fileConfig.ticketLogBotId || null,
  };
  for (const [k, v] of Object.entries(kv)) {
    const [group, ...rest] = k.split('.');
    const name = rest.join('.');
    if (group === 'role') {
      const [team, rank] = name.split('/');
      cache.roles[team] ||= {};
      cache.roles[team][rank] = v;
    } else if (group === 'channel') cache.channels[name] = v;
    else if (group === 'activity') cache.activityChannels[name] = v;
    else if (group === 'ticketLogBotId') cache.ticketLogBotId = v;
  }
  // تنظيف القيم الوهمية
  for (const t of Object.keys(cache.roles)) for (const k of Object.keys(cache.roles[t])) if (cache.roles[t][k] === 'ROLE_ID') delete cache.roles[t][k];
  for (const k of Object.keys(cache.channels)) if (cache.channels[k] === 'CHANNEL_ID') delete cache.channels[k];
  for (const k of Object.keys(cache.activityChannels)) if (!Array.isArray(cache.activityChannels[k])) delete cache.activityChannels[k];
  for (const k of ['ticket', 'staff', 'moderation']) cache.activityChannels[k] = (cache.activityChannels[k] || []).filter(x => /^\d+$/.test(x));
  return cache;
}

function set(key, value) {
  ensureTable();
  getDb().prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, JSON.stringify(value));
  cache = null;
}

function setRole(team, rank, roleId) { set(`role.${team}/${rank}`, roleId); }
function setGovernanceRole(roleId) { setRole('governance', 'Server Manager', roleId); }
function setChannel(name, channelId) { set(`channel.${name}`, channelId); }
function setActivity(type, ids) { set(`activity.${type}`, ids); }
function setTicketLogBotId(botId) { set('ticketLogBotId', botId || null); }

function roles() { return load().roles; }
function channels() { return load().channels; }
function activityChannels() { return load().activityChannels; }
function roleId(team, rank) { return load().roles[team]?.[rank] || null; }
function channelId(name) { return load().channels[name] || null; }
function ticketLogBotId() { return load().ticketLogBotId || null; }
function governanceRoleId() { return roleId('governance', 'Server Manager'); }
function vacationRoleId() { return roleId('system', 'in vacation'); }

/** حالة الإعداد: ما الذي ينقص */
function status() {
  const s = load();
  const missingRoles = [];
  for (const r of SUPPORT_RANKS) if (!s.roles.support[r.name]) missingRoles.push({ team: 'support', rank: r.name });
  for (const r of MOD_RANKS) if (!s.roles.moderation[r.name]) missingRoles.push({ team: 'moderation', rank: r.name });
  for (const r of GENERAL_MANAGEMENT_RANKS) if (!s.roles.general_management[r.name]) missingRoles.push({ team: 'general_management', rank: r.name });
  // قناة سجل التكتات الخارجية اختيارية، لأنها قناة يملكها/ينشئها بوت آخر.
  const CHANNELS = ['staff-faq', 'staff-updates', 'leave-requests', 'resignation-requests', 'staff-logs', 'performance-reports', 'staff-alerts', 'ticket-logs', 'mod-logs', 'manager-review'];
  const missingChannels = CHANNELS.filter(c => !s.channels[c]);
  const rolesDone = SUPPORT_RANKS.length + MOD_RANKS.length + GENERAL_MANAGEMENT_RANKS.length - missingRoles.length;
  return {
    missingRoles, missingChannels,
    rolesDone, rolesTotal: SUPPORT_RANKS.length + MOD_RANKS.length + GENERAL_MANAGEMENT_RANKS.length,
    channelsDone: CHANNELS.length - missingChannels.length, channelsTotal: CHANNELS.length,
    activity: s.activityChannels,
    ticketSourceConfigured: !!s.channels['ticket-source-logs'],
    ticketLogBotId: s.ticketLogBotId,
    governanceConfigured: !!governanceRoleId(),
    vacationRoleConfigured: !!vacationRoleId(),
    complete: missingRoles.length === 0 && missingChannels.length === 0,
    anyRole: rolesDone > 0,
  };
}

const CHANNEL_KEYS = ['staff-faq', 'staff-updates', 'leave-requests', 'resignation-requests', 'staff-logs', 'performance-reports', 'staff-alerts', 'ticket-logs', 'mod-logs', 'manager-review'];
const OPTIONAL_CHANNEL_KEYS = ['ticket-source-logs'];

module.exports = {
  load, set, setRole, setGovernanceRole, setChannel, setActivity, setTicketLogBotId,
  roles, channels, activityChannels, roleId, channelId, ticketLogBotId, governanceRoleId, vacationRoleId, status,
  CHANNEL_KEYS, OPTIONAL_CHANNEL_KEYS,
};
