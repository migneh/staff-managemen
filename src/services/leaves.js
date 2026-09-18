'use strict';
const { getDb } = require('../database');
const staffService = require('./staff');
const settings = require('./settings');
const { today, daysBetween, isValidDate } = require('../utils');

const APPROVED = "status = 'approved'";
const PENDING_OR_APPROVED = "status IN ('pending', 'approved')";

// ===== استعلامات أساسية =====
function concurrentApproved(start, end, excludeId = null) {
  const params = [end, start];
  let sql = `SELECT COUNT(DISTINCT user_id) c FROM leave_requests WHERE ${APPROVED} AND start_date <= ? AND end_date >= ?`;
  if (excludeId != null) { sql += ' AND id != ?'; params.push(Number(excludeId)); }
  return getDb().prepare(sql).get(...params).c;
}

function userHasOverlap(userId, start, end, { excludeId = null, includePending = true } = {}) {
  const params = [userId, end, start];
  let sql = `SELECT * FROM leave_requests WHERE user_id = ? AND ${includePending ? PENDING_OR_APPROVED : APPROVED}
    AND start_date <= ? AND end_date >= ?`;
  if (excludeId != null) { sql += ' AND id != ?'; params.push(Number(excludeId)); }
  return getDb().prepare(`${sql} ORDER BY start_date LIMIT 1`).get(...params) || null;
}

function approvedForUser(userId, { onOrAfter = today(), excludeId = null } = {}) {
  const params = [userId, onOrAfter];
  let sql = `SELECT * FROM leave_requests WHERE user_id = ? AND ${APPROVED} AND end_date >= ?`;
  if (excludeId != null) { sql += ' AND id != ?'; params.push(Number(excludeId)); }
  return getDb().prepare(`${sql} ORDER BY start_date`).all(...params);
}

function activeForUser(userId, date = today()) {
  return getDb().prepare(`SELECT * FROM leave_requests WHERE user_id = ? AND ${APPROVED}
    AND start_date <= ? AND end_date >= ? ORDER BY end_date DESC`).all(userId, date, date);
}

function pendingForUser(userId) {
  return getDb().prepare(`SELECT * FROM leave_requests WHERE user_id = ? AND status = 'pending' ORDER BY start_date`).all(userId);
}

function get(id) {
  return getDb().prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(id)) || null;
}

function list({ status = null, userId = null, page = 1, perPage = 10 } = {}) {
  let sql = 'SELECT * FROM leave_requests WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
  sql += ' ORDER BY CASE status WHEN \'pending\' THEN 0 WHEN \'approved\' THEN 1 ELSE 2 END, start_date DESC, id DESC';
  const all = getDb().prepare(sql).all(...params);
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(Number(page) || 1, 1), pages);
  const items = all.slice((current - 1) * perPage, current * perPage);
  return { items, total, pages, page: current };
}

function hasApprovedCover(userId, date = today(), excludeId = null) {
  return approvedForUser(userId, { onOrAfter: date, excludeId }).some(r => r.start_date <= date && r.end_date >= date);
}

// ===== قواعد واشتقاقات =====
function durationDays(start, end) {
  if (!isValidDate(start) || !isValidDate(end)) return null;
  return daysBetween(start, end) + 1;
}

function noticeHours(start, nowIso = new Date().toISOString()) {
  const target = Date.parse(`${start}T00:00:00Z`);
  const now = Date.parse(nowIso);
  if (Number.isNaN(target) || Number.isNaN(now)) return null;
  return Math.floor((target - now) / 3600000);
}

function daysInRangeForUser(userId, start, end) {
  // مجموع أيام الإجازات المعتمدة خلال 90 يوماً قبل نهاية النطاق
  const windowStart = new Date(`${end}T00:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - 89);
  const ws = windowStart.toISOString().slice(0, 10);
  const rows = getDb().prepare(`SELECT start_date, end_date FROM leave_requests WHERE user_id = ? AND ${APPROVED} AND end_date >= ? AND start_date <= ?`).all(userId, ws, end);
  let days = 0;
  for (const r of rows) {
    const s = r.start_date < ws ? ws : r.start_date;
    const e = r.end_date > end ? end : r.end_date;
    const d = daysBetween(s, e);
    if (d >= 0) days += d + 1;
  }
  return days;
}

function minGapViolated(userId, start, end, excludeId = null) {
  const policy = settings.leavePolicy();
  const gap = Number(policy.minGapDays || 1);
  if (gap <= 0) return null;
  // أقرب إجازة معتمدة قبل البداية وبعد النهاية
  const before = getDb().prepare(`SELECT end_date FROM leave_requests WHERE user_id = ? AND ${APPROVED} AND end_date < ? ${excludeId ? 'AND id != ?' : ''} ORDER BY end_date DESC LIMIT 1`)
    .get(userId, start, ...(excludeId ? [Number(excludeId)] : []));
  if (before) {
    const g = daysBetween(before.end_date, start) - 1;
    if (g < gap) return { side: 'before', gap: g, required: gap, neighbour: before.end_date };
  }
  const after = getDb().prepare(`SELECT start_date FROM leave_requests WHERE user_id = ? AND ${APPROVED} AND start_date > ? ${excludeId ? 'AND id != ?' : ''} ORDER BY start_date LIMIT 1`)
    .get(userId, end, ...(excludeId ? [Number(excludeId)] : []));
  if (after) {
    const g = daysBetween(end, after.start_date) - 1;
    if (g < gap) return { side: 'after', gap: g, required: gap, neighbour: after.start_date };
  }
  return null;
}

/**
 * تحقق شامل قبل إنشاء الطلب أو اعتماده.
 * يرجع { ok: true } أو { ok: false, code, message, hint }
 */
function validate({ userId, leaveType, start, end, excludeId = null, atApproval = false }) {
  const policy = settings.leavePolicy(leaveType);
  const global = settings.leavePolicy();

  if (!isValidDate(start) || !isValidDate(end)) return { ok: false, code: 'date_format', message: 'صيغة التاريخ غير صحيحة — استخدم YYYY-MM-DD.', hint: 'مثال: 2026-09-20' };
  const dur = durationDays(start, end);
  if (dur == null || dur < 1) return { ok: false, code: 'date_order', message: 'تاريخ النهاية قبل البداية.' };
  if (end < today() && !atApproval) return { ok: false, code: 'in_past', message: 'لا يمكن طلب إجازة في الماضي.' };
  if (dur > policy.maxDays) return { ok: false, code: 'type_cap', message: `إجازة «${policy.emoji || ''} ${leaveType}» لا تتجاوز ${policy.maxDays} أيام (طلبت ${dur}).`, hint: policy.note };
  if (dur > global.maxDays) return { ok: false, code: 'global_cap', message: `الحد الأقصى العام لأي إجازة هو ${global.maxDays} يوم.` };

  const nh = noticeHours(start);
  if (policy.minNoticeHours > 0 && nh != null && nh < policy.minNoticeHours && !atApproval) {
    return { ok: false, code: 'notice', message: `هذا النوع يحتاج إشعاراً قبل ${policy.minNoticeHours} ساعة.`, hint: `تبقى ${Math.max(0, nh)} ساعة فقط — اختر بداية لاحقة أو نوعاً طارئاً.` };
  }

  const days90 = daysInRangeForUser(userId, start, end);
  const wouldBe = days90 + dur - (excludeId ? (get(excludeId)?.duration_days || 0) : 0);
  const cap90 = policy.maxDaysPer90 || global.maxDaysPer90;
  if (cap90 && wouldBe > cap90) {
    return { ok: false, code: 'rolling_cap', message: `تجاوزت سقف ${cap90} يوم خلال 90 يوماً لهذا النوع (سيكون لديك ${wouldBe}).`, hint: 'قلّل المدة أو أجّل البداية.' };
  }

  const overlap = userHasOverlap(userId, start, end, { excludeId, includePending: !atApproval });
  if (overlap) return { ok: false, code: 'overlap', message: `لديك طلب متداخل #${overlap.id} (${overlap.start_date} → ${overlap.end_date}).`, hint: 'عدّل التواريخ أو ألغِ الطلب المتداخل.' };

  const gap = minGapViolated(userId, start, end, excludeId);
  if (gap) {
    const side = gap.side === 'before' ? 'تنتهي إجازتك السابقة' : 'تبدأ إجازتك اللاحقة';
    return { ok: false, code: 'gap', message: `${side} في ${gap.neighbour} — تحتاج ${gap.required} يوم راحة (لديك ${gap.gap}).` };
  }

  if (atApproval) {
    const c = concurrentApproved(start, end, excludeId);
    if (c >= global.maxConcurrent) return { ok: false, code: 'concurrent', message: `تم بلوغ الحد الأقصى (${global.maxConcurrent}) للمجازين في هذه الفترة.`, hint: `يوجد ${c} مجازين — جرّب فترة أخرى.` };
  }

  return { ok: true, durationDays: dur, noticeHours: nh };
}

// ===== تغطية اليوم والنطاق =====
function coverageFor(date = today()) {
  const rows = getDb().prepare(`SELECT user_id, leave_type, start_date, end_date FROM leave_requests WHERE ${APPROVED} AND start_date <= ? AND end_date >= ?`).all(date, date);
  return { date, count: rows.length, max: settings.leavePolicy().maxConcurrent, rows };
}

function coverageBetween(start, end) {
  // أقصى تداخل يومي خلال النطاق (مبسّط: كل تواريخ البداية/النهاية)
  const bounds = new Set([start, end]);
  for (const r of getDb().prepare(`SELECT start_date, end_date FROM leave_requests WHERE ${APPROVED} AND start_date <= ? AND end_date >= ?`).all(end, start)) {
    bounds.add(r.start_date); bounds.add(r.end_date);
  }
  let peak = 0; let peakDay = start;
  for (const d of [...bounds].sort()) {
    if (d < start || d > end) continue;
    const c = concurrentApproved(d, d);
    if (c > peak) { peak = c; peakDay = d; }
  }
  return { start, end, peak, peakDay, max: settings.leavePolicy().maxConcurrent };
}

// ===== إنشاء وتمديد وإنهاء =====
function createRequest({ userId, leaveType, reason, start, end, attachmentUrl = null }) {
  const vr = validate({ userId, leaveType, start, end });
  if (!vr.ok) return vr;
  const grantTiming = settings.leavePolicy().vacationRoleTiming || 'at_start';
  const db = getDb();
  const res = db.prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date, duration_days, notice_hours, attachment_url, role_grant_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(userId, leaveType, reason, start, end, vr.durationDays, vr.noticeHours, attachmentUrl, grantTiming === 'at_approval' ? start : start);
  return { ok: true, row: get(res.lastInsertRowid) };
}

function extendRequest({ id, userId, newEnd, actorId }) {
  const row = get(id);
  if (!row || row.user_id !== userId) return { ok: false, code: 'not_found', message: 'الطلب غير موجود.' };
  if (!['pending', 'approved'].includes(row.status)) return { ok: false, code: 'status', message: 'يمكن تمديد الطلبات المعلقة أو المعتمدة فقط.' };
  if (!isValidDate(newEnd)) return { ok: false, code: 'date_format', message: 'صيغة التاريخ غير صحيحة.' };
  if (newEnd <= row.end_date) return { ok: false, code: 'date_order', message: 'تاريخ التمديد يجب أن يكون بعد النهاية الحالية.' };
  if (row.extended_count >= 2) return { ok: false, code: 'extend_limit', message: 'لا يمكن تمديد هذا الطلب أكثر من مرتين.' };
  const vr = validate({ userId: row.user_id, leaveType: row.leave_type, start: row.start_date, end: newEnd, excludeId: row.id, atApproval: row.status === 'approved' });
  if (!vr.ok) return vr;
  const db = getDb();
  db.prepare(`UPDATE leave_requests SET end_date = ?, duration_days = ?, extended_count = extended_count + 1, updated_at = datetime('now') WHERE id = ?`).run(newEnd, vr.durationDays, row.id);
  const audit = require('./audit');
  audit.record({ action: 'leave_extended', actorId, targetId: row.user_id, details: { requestId: row.id, from: row.end_date, to: newEnd } });
  return { ok: true, row: get(row.id) };
}

async function syncVacationRole(member, date = today()) {
  if (!member) return { ok: true, skipped: true };
  const timing = settings.leavePolicy().vacationRoleTiming || 'at_start';
  if (timing === 'at_approval') {
    // يوجد طلب معتمد يغطي اليوم أو سيبدأ مستقبلاً
    const hasAnyApproved = getDb().prepare(`SELECT 1 FROM leave_requests WHERE user_id = ? AND ${APPROVED} LIMIT 1`).get(member.id);
    return hasAnyApproved ? staffService.addVacationRole(member) : staffService.removeVacationRole(member);
  }
  // at_start: فقط عندما تكون الإجازة نشطة فعلياً
  const shouldHave = hasApprovedCover(member.id, date) || false;
  // لكن لا تُزلها إن كان هناك إجازة معتمدة قادمة خلال 24 ساعة ويُعتمد أن الرتبة تبقى
  if (!shouldHave && approvedForUser(member.id, { onOrAfter: date }).some(r => r.start_date > date)) {
    // اتركها إن كان بالفعل يملكها تجنباً للوميض
    try { if (member.roles?.cache?.has?.(settings.vacationRoleId())) return { ok: true, keep: true }; } catch {}
  }
  return shouldHave ? staffService.addVacationRole(member) : staffService.removeVacationRole(member);
}

function markReminder(id, current, key) {
  const sent = new Set(String(current || '').split(',').filter(Boolean));
  if (sent.has(key)) return false;
  sent.add(key);
  getDb().prepare('UPDATE leave_requests SET reminders_sent = ? WHERE id = ?').run([...sent].join(','), id);
  return true;
}

module.exports = {
  concurrentApproved, userHasOverlap, approvedForUser, activeForUser, pendingForUser, get, list,
  hasApprovedCover, syncVacationRole, markReminder,
  durationDays, noticeHours, daysInRangeForUser, minGapViolated, validate,
  coverageFor, coverageBetween, createRequest, extendRequest,
};
