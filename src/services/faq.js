'use strict';
const { getDb } = require('../database');
const { FAQ_CATEGORIES } = require('../constants');

function category(id) { return FAQ_CATEGORIES.find(c => c.id === Number(id)) || null; }

function list(categoryId) {
  const db = getDb();
  return categoryId
    ? db.prepare('SELECT * FROM faq_entries WHERE category_id = ? ORDER BY id').all(categoryId)
    : db.prepare('SELECT * FROM faq_entries ORDER BY category_id, id').all();
}

function get(id) { return getDb().prepare('SELECT * FROM faq_entries WHERE id = ?').get(id) || null; }

function search(q) {
  return getDb().prepare(`SELECT * FROM faq_entries WHERE title LIKE ? OR content LIKE ? ORDER BY category_id, id LIMIT 25`).all(`%${q}%`, `%${q}%`);
}

function add({ categoryId, title, content, important, userId }) {
  const db = getDb();
  const res = db.prepare(`INSERT INTO faq_entries (category_id, title, content, is_important, created_by) VALUES (?, ?, ?, ?, ?)`)
    .run(categoryId, title, content, important ? 1 : 0, userId);
  db.prepare(`INSERT INTO faq_history (entry_id, version, action, title, content, category_id, changed_by) VALUES (?, 1, 'create', ?, ?, ?, ?)`)
    .run(res.lastInsertRowid, title, content, categoryId, userId);
  return get(res.lastInsertRowid);
}

function edit(id, { categoryId, title, content, important, userId }) {
  const db = getDb();
  const cur = get(id);
  if (!cur) return null;
  const v = cur.version + 1;
  db.prepare(`UPDATE faq_entries SET category_id = ?, title = ?, content = ?, is_important = ?, updated_by = ?, version = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(categoryId ?? cur.category_id, title ?? cur.title, content ?? cur.content, important == null ? cur.is_important : (important ? 1 : 0), userId, v, id);
  db.prepare(`INSERT INTO faq_history (entry_id, version, action, title, content, category_id, changed_by) VALUES (?, ?, 'edit', ?, ?, ?, ?)`)
    .run(id, v, title ?? cur.title, content ?? cur.content, categoryId ?? cur.category_id, userId);
  // تعديل المدخل يعني قراءة جديدة مطلوبة
  db.prepare('DELETE FROM policy_acknowledgements WHERE entry_id = ? AND version < ?').run(id, v);
  return get(id);
}

function remove(id, userId) {
  const db = getDb();
  const cur = get(id);
  if (!cur) return null;
  db.prepare(`INSERT INTO faq_history (entry_id, version, action, title, content, category_id, changed_by) VALUES (?, ?, 'delete', ?, ?, ?, ?)`)
    .run(id, cur.version, cur.title, cur.content, cur.category_id, userId);
  db.prepare('DELETE FROM faq_entries WHERE id = ?').run(id);
  db.prepare('DELETE FROM policy_acknowledgements WHERE entry_id = ?').run(id);
  return cur;
}

function history(id) { return getDb().prepare('SELECT * FROM faq_history WHERE entry_id = ? ORDER BY version DESC').all(id); }

// ===== نظام القراءة =====
function acknowledge(entryId, userId, version) {
  getDb().prepare(`INSERT INTO policy_acknowledgements (entry_id, user_id, version, acknowledged_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(entry_id, user_id) DO UPDATE SET version = excluded.version, acknowledged_at = excluded.acknowledged_at`).run(entryId, userId, version);
}
function hasRead(entryId, userId) {
  const e = get(entryId);
  const a = getDb().prepare('SELECT version FROM policy_acknowledgements WHERE entry_id = ? AND user_id = ?').get(entryId, userId);
  return !!(a && e && a.version >= e.version);
}
function unreadFor(userId) {
  return getDb().prepare(`SELECT e.* FROM faq_entries e LEFT JOIN policy_acknowledgements a ON a.entry_id = e.id AND a.user_id = ?
    WHERE e.is_important = 1 AND (a.entry_id IS NULL OR a.version < e.version) ORDER BY e.category_id, e.id`).all(userId);
}
function readers(entryId) {
  return getDb().prepare('SELECT user_id, acknowledged_at FROM policy_acknowledgements WHERE entry_id = ?').all(entryId);
}

// ===== اللوحات =====
function addPanel(messageId, channelId, userId) {
  getDb().prepare('INSERT OR REPLACE INTO faq_panels (message_id, channel_id, created_by) VALUES (?, ?, ?)').run(messageId, channelId, userId);
}
function panels() { return getDb().prepare('SELECT * FROM faq_panels').all(); }
function removePanel(messageId) { getDb().prepare('DELETE FROM faq_panels WHERE message_id = ?').run(messageId); }

function counts() {
  const rows = getDb().prepare('SELECT category_id, COUNT(*) c FROM faq_entries GROUP BY category_id').all();
  return Object.fromEntries(rows.map(r => [r.category_id, r.c]));
}

module.exports = { category, list, get, search, add, edit, remove, history, acknowledge, hasRead, unreadFor, readers, addPanel, panels, removePanel, counts };
