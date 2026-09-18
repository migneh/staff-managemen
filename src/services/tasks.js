'use strict';
const { getDb } = require('../database');
const { nowIso } = require('../utils');

function ensureOnboarding(userId) {
  const db = getDb();
  const existing = db.prepare("SELECT COUNT(*) c FROM staff_tasks WHERE user_id = ? AND task_type = 'onboarding'").get(userId).c;
  if (existing) return;
  const insert = db.prepare('INSERT INTO staff_tasks (user_id, title, description, task_type, assigned_by) VALUES (?, ?, ?, \'onboarding\', ?)');
  const seed = db.transaction(() => {
    insert.run(userId, 'قراءة قاعدة المعرفة الأساسية', 'اقرأ القوانين والسياسات المهمة من /faq.', 'system');
    insert.run(userId, 'قراءة نظام الأداء والترقيات', 'راجع /promotion-info وافهم طريقة احتساب Score والنقاط.', 'system');
    insert.run(userId, 'تأكيد الجاهزية', 'افتح /my-tasks واضغط زر الإنهاء بعد إنهاء خطوات التأهيل.', 'system');
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

function list(userId, { includeCompleted = false, limit = 20 } = {}) {
  return getDb().prepare(`SELECT * FROM staff_tasks WHERE user_id = ? ${includeCompleted ? '' : "AND status = 'pending'"}
    ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, COALESCE(due_date, '9999-12-31'), id DESC LIMIT ?`).all(userId, limit);
}

function pendingCount(userId) {
  return getDb().prepare("SELECT COUNT(*) c FROM staff_tasks WHERE user_id = ? AND status = 'pending'").get(userId).c;
}

function complete(id, userId) {
  const db = getDb();
  const task = db.prepare("SELECT * FROM staff_tasks WHERE id = ? AND user_id = ? AND status = 'pending'").get(Number(id), userId);
  if (!task) return null;
  db.prepare("UPDATE staff_tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?")
    .run(nowIso(), nowIso(), task.id);
  if (task.task_type === 'onboarding') {
    const remaining = db.prepare("SELECT COUNT(*) c FROM staff_tasks WHERE user_id = ? AND task_type = 'onboarding' AND status = 'pending'").get(userId).c;
    if (!remaining) db.prepare("UPDATE staff_members SET status = CASE WHEN status = 'probation' THEN 'active' ELSE status END, updated_at = ? WHERE user_id = ?").run(nowIso(), userId);
  }
  return get(task.id);
}

/** إلغاء مهمة مع تسجيل مَن ألغاها ومتى — كان المعامل actorId مُهمَلاً سابقاً */
function cancel(id, actorId = null) {
  const res = getDb().prepare(`UPDATE staff_tasks SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'`).run(actorId, nowIso(), nowIso(), Number(id));
  return res.changes > 0;
}

module.exports = { ensureOnboarding, create, get, list, pendingCount, complete, cancel };
