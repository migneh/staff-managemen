'use strict';
const { getDb } = require('../database');
const { FAQ_CATEGORIES } = require('../constants');

const DEFAULT_TEMPLATE = {
  id: 0,
  name: 'اللوحة الافتراضية',
  title: '📚 قاعدة المعرفة — Staff FAQ',
  description: '> كل ما تحتاج معرفته كإداري في مكان واحد.\n> اختر تصنيفاً من القائمة، أو ابحث، أو اضغط **غير المقروءة** لترى ما ينتظرك.\n\u200b',
  categoryIds: FAQ_CATEGORIES.map(c => c.id),
  color: 0x5865f2,
  version: 1,
};

function category(id) { return FAQ_CATEGORIES.find(c => c.id === Number(id)) || null; }

function parseCategoryIds(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isInteger);
  try { return JSON.parse(value || '[]').map(Number).filter(Number.isInteger); } catch { return []; }
}

function normalizeCategoryIds(value) {
  const ids = [...new Set(parseCategoryIds(value))].filter(id => category(id));
  return ids.length ? ids : FAQ_CATEGORIES.map(c => c.id);
}

function mapTemplate(row) {
  if (!row) return null;
  return { ...row, categoryIds: normalizeCategoryIds(row.category_ids), category_ids: undefined };
}

function template(id) {
  if (!Number(id)) return { ...DEFAULT_TEMPLATE, categoryIds: [...DEFAULT_TEMPLATE.categoryIds] };
  return mapTemplate(getDb().prepare('SELECT * FROM faq_templates WHERE id = ?').get(Number(id)));
}

function templates() {
  return getDb().prepare('SELECT * FROM faq_templates ORDER BY id').all().map(mapTemplate);
}

function templateCategories(id) {
  const t = template(id) || DEFAULT_TEMPLATE;
  return FAQ_CATEGORIES.filter(c => t.categoryIds.includes(c.id));
}

function list(categoryId) {
  const db = getDb();
  return categoryId
    ? db.prepare('SELECT * FROM faq_entries WHERE category_id = ? ORDER BY id').all(categoryId)
    : db.prepare('SELECT * FROM faq_entries ORDER BY category_id, id').all();
}

function listForTemplate(templateId, categoryId) {
  const t = template(templateId) || DEFAULT_TEMPLATE;
  const allowed = new Set(t.categoryIds);
  if (categoryId != null && !allowed.has(Number(categoryId))) return [];
  return list(categoryId).filter(entry => allowed.has(entry.category_id));
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

// ===== قوالب FAQ المستقلة =====
function addTemplate({ name, title, description, categoryIds, color, userId }) {
  const db = getDb();
  const ids = normalizeCategoryIds(categoryIds);
  const result = db.prepare(`INSERT INTO faq_templates (name, title, description, category_ids, color, created_by)
    VALUES (?, ?, ?, ?, ?, ?)`).run(name.trim(), title.trim(), description?.trim() || '', JSON.stringify(ids), color ?? DEFAULT_TEMPLATE.color, userId);
  db.prepare(`INSERT INTO faq_template_history (template_id, version, action, name, title, description, category_ids, color, changed_by)
    VALUES (?, 1, 'create', ?, ?, ?, ?, ?, ?)`).run(result.lastInsertRowid, name.trim(), title.trim(), description?.trim() || '', JSON.stringify(ids), color ?? DEFAULT_TEMPLATE.color, userId);
  return template(result.lastInsertRowid);
}

function editTemplate(id, { name, title, description, categoryIds, color, userId }) {
  const db = getDb();
  const current = template(id);
  if (!current || current.id === 0) return null;
  const next = {
    name: name?.trim() || current.name,
    title: title?.trim() || current.title,
    description: description == null ? current.description : description.trim(),
    categoryIds: categoryIds == null ? current.categoryIds : normalizeCategoryIds(categoryIds),
    color: color ?? current.color,
  };
  const version = current.version + 1;
  db.prepare(`UPDATE faq_templates SET name = ?, title = ?, description = ?, category_ids = ?, color = ?, updated_by = ?, version = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(next.name, next.title, next.description, JSON.stringify(next.categoryIds), next.color, userId, version, id);
  db.prepare(`INSERT INTO faq_template_history (template_id, version, action, name, title, description, category_ids, color, changed_by)
    VALUES (?, ?, 'edit', ?, ?, ?, ?, ?, ?)`).run(id, version, next.name, next.title, next.description, JSON.stringify(next.categoryIds), next.color, userId);
  return template(id);
}

function removeTemplate(id, userId) {
  const db = getDb();
  const current = template(id);
  if (!current || current.id === 0) return null;
  db.prepare(`INSERT INTO faq_template_history (template_id, version, action, name, title, description, category_ids, color, changed_by)
    VALUES (?, ?, 'delete', ?, ?, ?, ?, ?, ?)`).run(id, current.version, current.name, current.title, current.description, JSON.stringify(current.categoryIds), current.color, userId);
  // اللوحات المنشورة لا تختفي فجأة؛ تتحول إلى اللوحة الافتراضية.
  db.prepare('UPDATE faq_panels SET template_id = 0 WHERE template_id = ?').run(id);
  db.prepare('DELETE FROM faq_templates WHERE id = ?').run(id);
  return current;
}

function templateHistory(id) { return getDb().prepare('SELECT * FROM faq_template_history WHERE template_id = ? ORDER BY version DESC, id DESC').all(id); }

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

// ===== اللوحات المنشورة =====
function addPanel(messageId, channelId, userId, templateId = 0) {
  getDb().prepare('INSERT OR REPLACE INTO faq_panels (message_id, channel_id, created_by, template_id) VALUES (?, ?, ?, ?)').run(messageId, channelId, userId, Number(templateId) || 0);
}
function panels() { return getDb().prepare('SELECT * FROM faq_panels').all(); }
function removePanel(messageId) { getDb().prepare('DELETE FROM faq_panels WHERE message_id = ?').run(messageId); }

function counts(categoryIds) {
  const rows = categoryIds?.length
    ? getDb().prepare(`SELECT category_id, COUNT(*) c FROM faq_entries WHERE category_id IN (${categoryIds.map(() => '?').join(',')}) GROUP BY category_id`).all(...categoryIds)
    : getDb().prepare('SELECT category_id, COUNT(*) c FROM faq_entries GROUP BY category_id').all();
  return Object.fromEntries(rows.map(r => [r.category_id, r.c]));
}

module.exports = {
  DEFAULT_TEMPLATE, category, list, listForTemplate, get, search, add, edit, remove, history,
  addTemplate, editTemplate, removeTemplate, template, templates, templateCategories, templateHistory,
  acknowledge, hasRead, unreadFor, readers, addPanel, panels, removePanel, counts,
};
