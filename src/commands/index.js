'use strict';
const modules = [
  require('./setup'),
  require('./help'),
  require('./faq'),
  require('./logging'),
  require('./leaves'),
  require('./resignations'),
  require('./records'),
  require('./promotions'),
  require('./reports'),
];

const commands = new Map();
const components = new Map();

for (const m of modules) {
  for (const c of m.commands || []) commands.set(c.data.name, c);
  for (const [k, h] of Object.entries(m.components || {})) components.set(k, h);
}

/** يفكك customId مثل "faq:ack:12" إلى المفتاح "faq:ack" والمعاملات ["12"] */
function resolveComponent(customId) {
  const parts = customId.split(':');
  for (let n = parts.length; n >= 1; n--) {
    const key = parts.slice(0, n).join(':');
    if (components.has(key)) return { handler: components.get(key), args: parts.slice(n) };
  }
  return null;
}

module.exports = { commands, components, resolveComponent, modules };
