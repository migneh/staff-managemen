'use strict';
/**
 * إعدادات السيرفر (الرتب والقنوات) — تُخزن في قاعدة البيانات وتُضبط عبر /setup.
 * config.json يبقى مصدراً احتياطياً (اختياري).
 */
const { getDb } = require('../database');
const fileConfig = require('../config');
const logger = require('../logger').log('settings');
const {
  SUPPORT_RANKS, MOD_RANKS, GENERAL_MANAGEMENT_RANKS, LEAVE_GLOBAL, LEAVE_RULES, RESIGNATION_GLOBAL, VACATION_ROLE_TIMING,
  CHANNEL_KEYS, OPTIONAL_CHANNEL_KEYS, CHANNEL_META, SCORE_WEIGHTS,
} = require('../constants');

let cache = null;

/**
 * قراءة آمنة لقيم settings: صف تالف واحد يجب ألا يُسقط البوت كله.
 * القيمة غير الصالحة تُتجاهل وتُسجَّل، ويستمر كل ما عداها.
 */
function safeParse(key, value) {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (e) {
    logger.error(`قيمة تالفة في الإعدادات — تم تجاهل "${key}": ${e.message}`);
    return { ok: false };
  }
}

function ensureTable() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
}

function load() {
  if (cache) return cache;
  ensureTable();
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const kv = {};
  for (const row of rows) {
    const parsed = safeParse(row.key, row.value);
    if (parsed.ok) kv[row.key] = parsed.value;
  }
  const fileRoles = fileConfig.roles || {};
  cache = {
    policies: Object.fromEntries(Object.entries(kv).filter(([k]) => k.startsWith('policy.')).map(([k, v]) => [k.slice(7), v])),
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
  for (const k of Object.keys(cache.channels)) if (['CHANNEL_ID', 'OPTIONAL_CHANNEL_ID'].includes(cache.channels[k])) delete cache.channels[k];
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

// ===== سياسات الطلبات (تُضبط من /setup وتُفضَّل على config.json) =====
function policy(key, fallback = null) {
  const value = load().policies?.[key];
  return value === undefined || value === null || value === '' ? fallback : value;
}
function setPolicy(key, value) { set(`policy.${key}`, value); }

function scoreWeights(team) {
  const key = team === 'support' ? 'support' : team === 'moderation' ? 'moderation' : 'helper';
  const fallback = SCORE_WEIGHTS[key];
  const configured = policy('scoreWeights', {});
  const candidate = configured?.[key];
  const keys = Object.keys(fallback);
  if (!candidate || keys.some(name => !Object.prototype.hasOwnProperty.call(candidate, name)) || Object.keys(candidate).some(name => !keys.includes(name)) || Object.values(candidate).some(v => !Number.isInteger(Number(v)) || Number(v) < 0) || keys.reduce((sum, name) => sum + Number(candidate[name]), 0) !== 100) return { ...fallback };
  return Object.fromEntries(Object.entries(fallback).map(([name, value]) => [name, Number(candidate[name] ?? value)]));
}

function setScoreWeights(team, values) {
  const key = team === 'support' ? 'support' : team === 'moderation' ? 'moderation' : 'helper';
  const next = { ...(policy('scoreWeights', {}) || {}), [key]: values };
  setPolicy('scoreWeights', next);
  return scoreWeights(key);
}

function resetPolicy(key) {
  ensureTable();
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(`policy.${key}`);
  cache = null;
}

/** قواعد الإجازات: الافتراضي ← config.json ← إعداد /setup */
function leavePolicy(type = null) {
  const base = { ...LEAVE_GLOBAL, ...(fileConfig.leave || {}) };
  const rules = Object.fromEntries(Object.entries(LEAVE_RULES).map(([key, rule]) => [key, { ...rule }]));
  for (const [type2, rule] of Object.entries(rules)) {
    const override = policy(`leaveType.${type2}`, {});
    if (override && typeof override === 'object') Object.assign(rule, override);
  }
  const overrides = {
    maxDays: policy('leaveMaxDays'), maxConcurrent: policy('leaveMaxConcurrent'),
    pendingExpireDays: policy('leavePendingExpireDays'), maxDaysPer90: policy('leaveMaxDaysPer90'),
    vacationRoleTiming: policy('vacationRoleTiming', base.vacationRoleTiming || 'at_start'),
  };
  for (const [k, v] of Object.entries(overrides)) if (v != null) base[k] = v;
  const result = type ? { ...base, ...(rules[type] || {}), rules } : { ...base, rules };
  result.maxDays = Number(result.maxDays) || LEAVE_GLOBAL.maxDays;
  result.maxConcurrent = Number(result.maxConcurrent) || LEAVE_GLOBAL.maxConcurrent;
  result.maxDaysPer90 = Number(result.maxDaysPer90) || LEAVE_GLOBAL.maxDaysPer90;
  result.pendingExpireDays = Number(result.pendingExpireDays) || LEAVE_GLOBAL.pendingExpireDays;
  result.minNoticeHours = Number(result.minNoticeHours || 0);
  return result;
}

/** قواعد الاستقالة */
function resignationPolicy() {
  const base = { ...RESIGNATION_GLOBAL, ...(fileConfig.resignation || {}) };
  const overrides = { noticeDays: policy('resignationNoticeDays'), pendingEscalateDays: policy('resignationEscalateDays') };
  for (const [k, v] of Object.entries(overrides)) if (v != null) base[k] = v;
  base.noticeDays = Number(base.noticeDays) || RESIGNATION_GLOBAL.noticeDays;
  base.pendingEscalateDays = Number(base.pendingEscalateDays) || RESIGNATION_GLOBAL.pendingEscalateDays;
  return base;
}

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
  const missingChannels = CHANNEL_KEYS.filter(c => !s.channels[c]);
  const rolesDone = SUPPORT_RANKS.length + MOD_RANKS.length + GENERAL_MANAGEMENT_RANKS.length - missingRoles.length;
  return {
    missingRoles, missingChannels,
    rolesDone, rolesTotal: SUPPORT_RANKS.length + MOD_RANKS.length + GENERAL_MANAGEMENT_RANKS.length,
    channelsDone: CHANNEL_KEYS.length - missingChannels.length, channelsTotal: CHANNEL_KEYS.length,
    activity: s.activityChannels,
    ticketSourceConfigured: !!s.channels['ticket-source-logs'],
    ticketLogBotId: s.ticketLogBotId,
    governanceConfigured: !!governanceRoleId(),
    vacationRoleConfigured: !!vacationRoleId(),
    leavePolicy: leavePolicy(),
    resignationPolicy: resignationPolicy(),
    complete: missingRoles.length === 0 && missingChannels.length === 0,
    anyRole: rolesDone > 0,
  };
}

module.exports = {
  load, set, setRole, setGovernanceRole, setChannel, setActivity, setTicketLogBotId,
  roles, channels, activityChannels, roleId, channelId, ticketLogBotId, governanceRoleId, vacationRoleId, status,
  policy, setPolicy, resetPolicy, scoreWeights, setScoreWeights, leavePolicy, resignationPolicy, VACATION_ROLE_TIMING,
  CHANNEL_KEYS, OPTIONAL_CHANNEL_KEYS, CHANNEL_META,
};
