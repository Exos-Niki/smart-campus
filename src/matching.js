'use strict';
// Automatic lost-and-found matching: scores a lost item against a found item (0-98).
const STOP = new Set(['the', 'and', 'with', 'for', 'set', 'near', 'from', 'one', 'his', 'her', 'pair', 'left', 'inside', 'found', 'name', 'back']);
const THRESHOLD = 45;
const DAY = 864e5;

const toks = s => new Set((String(s).toLowerCase().match(/[a-z0-9]+/g) || [])
  .map(w => w.replace(/s$/, ''))
  .filter(w => w.length > 2 && !STOP.has(w)));

function scorePair(l, f) {
  const why = [];
  let s = 0;
  if (l.category === f.category) { s += 30; why.push('Same category'); }
  if (l.place === f.place) { s += 20; why.push('Same block'); }
  const a = toks(l.title + ' ' + l.desc), b = toks(f.title + ' ' + f.desc);
  const common = [...a].filter(w => b.has(w));
  if (common.length) {
    s += Math.min(40, Math.round(common.length / Math.min(a.size, b.size) * 60));
    why.push('Shared words: ' + common.slice(0, 4).join(', '));
  }
  if (Math.abs(new Date(l.date) - new Date(f.date)) / DAY <= 3) { s += 10; why.push('Dates within 3 days'); }
  return { s: Math.min(98, s), why };
}

module.exports = { scorePair, THRESHOLD };
