'use strict';
const { getDb } = require('../database');
const { nowIso, today, addDays } = require('../utils');

function ensureOnboarding(userId) {
  const db = getDb();
  const existing = db.prepare("SELECT COUNT(*) c FROM staff_tasks WHERE user_id = ? AND task_type = 'onboarding'").get(userId).c;
  if (existing) return;
  const insert = db.prepare('INSERT INTO staff_tasks (user_id, title, description, task_type, due_date, assigned_by) VALUES (?, ?, ?, \'onboarding\', ?, ?)');
  const start = today();
  const seed = db.transaction(() => {
    insert.run(userId, 'قراءة قاعدة المعرفة الأساسية', 'اقرأ القوانين والسياسات المهمة من /faq.', addDays(start, 2), 'system');
    insert.run(userId, 'قراءة نظام الأداء والترقيات', 'راجع /promotion-info وافهم طريقة احتساب Score والنقاط.', addDays(start, 4), 'system');
    insert.run(userId, 'تأكيد الجاهزية', 'أكمل الخطوتين ثم اضغط زر الإنهاء. بعدها يراجع المدير جاهزيتك قبل التحويل من التجربة إلى نشط.', addDays(start, 7), 'system');
  });
  seed();
}

function create({ userId, title, description, taskType = 'general', dueDate = null, assignedBy = null }) {
  const result = getDb().prepare(`INSERT INTO staff_tasks (user_id, title, description, task_type, due_date, assigned_by)
    VALUES (?, ?, ?, ?, ?, ?)`).run(userId, title, description || null, taskType, dueDate || null, assignedBy || null);
  return get(result.lastInsertRowid);
}

function get(id) {
  return getDb().prepare('SELECT * FROM staff_tasks WHERE id = ?').get(Number(id)) || null;
}

function list(userId, { includeCompleted = false, limit = 20, offset = 0 } = {}) {
  return getDb().prepare(`SELECT * FROM staff_tasks WHERE user_id = ? AND task_type != 'points_appeal' ${includeCompleted ? '' : "AND status = 'pending'"}
    ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, COALESCE(due_date, '9999-12-31'), id DESC LIMIT ? OFFSET ?`).all(userId, limit, offset);
}

function listPage(userId, { includeCompleted = false, page = 1 } = {}) {
  const total = getDb().prepare(`SELECT COUNT(*) c FROM staff_tasks WHERE user_id = ? AND task_type != 'points_appeal' ${includeCompleted ? '' : "AND status = 'pending'"}`).get(userId).c;
  const pages = Math.max(1, Math.ceil(total / 5));
  const current = Math.min(Math.max(Number.isSafeInteger(Number(page)) ? Number(page) : 1, 1), pages);
  return { items: list(userId, { includeCompleted, limit: 5, offset: (current - 1) * 5 }), page: current, pages, total };
}

function pendingCount(userId) {
  return getDb().prepare("SELECT COUNT(*) c FROM staff_tasks WHERE user_id = ? AND status = 'pending' AND task_type != 'points_appeal'").get(userId).c;
}

function listByType(taskType, { includeCompleted = false, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return getDb().prepare(`SELECT * FROM staff_tasks WHERE task_type = ? ${includeCompleted ? '' : "AND status = 'pending'"}
    ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, id DESC LIMIT ?`).all(taskType, safeLimit);
}

function approveOnboarding(userId, approvedBy) {
  const db = getDb();
  const target = db.prepare("SELECT * FROM staff_members WHERE user_id = ? AND status = 'probation'").get(userId);
  if (!target || !target.onboarding_ready) return null;
  const pending = db.prepare("SELECT COUNT(*) c FROM staff_tasks WHERE user_id = ? AND task_type = 'onboarding' AND status = 'pending'").get(userId).c;
  if (pending) return null;
  db.prepare("UPDATE staff_members SET status = 'active', onboarding_ready = 0, onboarding_approved_by = ?, onboarding_approved_at = ?, updated_at = ? WHERE user_id = ?")
    .run(approvedBy || null, nowIso(), nowIso(), userId);
  return db.prepare('SELECT * FROM staff_members WHERE user_id = ?').get(userId);
}

function complete(id, userId) {
  const db = getDb();
  const task = db.prepare("SELECT * FROM staff_tasks WHERE id = ? AND user_id = ? AND status = 'pending' AND task_type != 'points_appeal'").get(Number(id), userId);
  if (!task) return null;
  db.prepare("UPDATE staff_tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?")
    .run(nowIso(), nowIso(), task.id);
  if (task.task_type === 'onboarding') {
    const remaining = db.prepare("SELECT COUNT(*) c FROM staff_tasks WHERE user_id = ? AND task_type = 'onboarding' AND status = 'pending'").get(userId).c;
    if (!remaining) db.prepare("UPDATE staff_members SET onboarding_ready = 1, updated_at = ? WHERE user_id = ?").run(nowIso(), userId);
  }
  return get(task.id);
}

/** إلغاء مهمة مع تسجيل مَن ألغاها ومتى — كان المعامل actorId مُهمَلاً سابقاً */
function cancel(id, actorId = null) {
  const res = getDb().prepare(`UPDATE staff_tasks SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'`).run(actorId, nowIso(), nowIso(), Number(id));
  return res.changes > 0;
}

module.exports = { ensureOnboarding, create, get, list, listPage, listByType, pendingCount, approveOnboarding, complete, cancel };
