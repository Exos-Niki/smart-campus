'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./src/db');
const { scorePair, THRESHOLD } = require('./src/matching');

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('JWT_SECRET must be set in production.');
  process.exit(1);
}
const SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
if (!process.env.JWT_SECRET) console.warn('[warn] JWT_SECRET is not set. Using an insecure development secret.');
const UPLOADS = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

/* ---------- constants + helpers ---------- */
const ROLES = ['student', 'staff', 'technician', 'admin'];
const BLOCKS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const CATS_L = ['ID / Cards', 'Electronics', 'Bags', 'Books & Stationery', 'Keys', 'Clothing', 'Other'];
const KEPT = ['Security desk', 'Library desk', 'Admin Block', 'Sports office'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[0-9+\s-]{10,14}$/;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const need = (cond, msg, status = 400) => { if (!cond) throw new HttpError(status, msg); };
const text = (v, min, max, label) => {
  const t = typeof v === 'string' ? v.trim() : '';
  need(t.length >= min, `${label} needs at least ${min} characters`);
  need(t.length <= max, `${label} is too long (max ${max} characters)`);
  return t;
};
const h = fn => (req, res, next) => {
  try { fn(req, res, next); } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Something went wrong on the server' });
  }
};
const sign = u => jwt.sign({ id: u.id }, SECRET, { expiresIn: '8h' });
const pub = (u, full) => ({ id: u.id, name: u.name, role: u.role, spec: u.spec || undefined, active: !!u.active,
  ...(full ? { email: u.email, phone: u.phone } : {}) });

function auth(req, res, next) {
  const hd = req.headers.authorization || '';
  const t = hd.startsWith('Bearer ') ? hd.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'Please sign in' });
  try {
    const p = jwt.verify(t, SECRET);
    const u = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(p.id);
    if (!u) return res.status(401).json({ error: 'This account is not available' });
    req.user = u; next();
  } catch (e) { res.status(401).json({ error: 'Your session expired. Please sign in again' }); }
}
const only = (...r) => (req, res, next) => r.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not allowed for your role' });

const attempts = new Map();
const limited = k => { const now = Date.now(), a = (attempts.get(k) || []).filter(t => now - t < 15 * 60 * 1000); attempts.set(k, a); return a.length >= 10; };
const failed = k => { const a = attempts.get(k) || []; a.push(Date.now()); attempts.set(k, a); };

const insNotif = db.prepare('INSERT INTO notifications(user_id,text,link,at) VALUES(?,?,?,?)');
function notify(ids, msg, link, except) {
  const at = new Date().toISOString();
  [...new Set(ids.filter(x => x && x !== except))].forEach(id => insNotif.run(id, msg, link || '#/notifications', at));
}
const idsOf = roles => db.prepare(`SELECT id FROM users WHERE active=1 AND role IN (${roles.map(() => '?').join(',')})`).all(...roles).map(r => r.id);

const toLost = r => ({ id: r.id, title: r.title, category: r.category, place: r.place, date: r.date, desc: r.description, by: r.by_user, status: r.status });
const toFound = r => ({ ...toLost(r), kept: r.kept, claim: r.claim_by ? { by: r.claim_by, proof: r.claim_proof, at: r.claim_at } : null });
function allMatches() {
  const L = db.prepare('SELECT * FROM lost_items').all().map(toLost), F = db.prepare('SELECT * FROM found_items').all().map(toFound), out = [];
  L.forEach(l => F.forEach(f => { const r = scorePair(l, f); if (r.s >= THRESHOLD) out.push({ key: l.id + '|' + f.id, lostId: l.id, foundId: f.id, s: r.s, why: r.why }); }));
  return out.sort((a, b) => b.s - a.s);
}
function attach(rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id), q = ids.map(() => '?').join(',');
  const grp = sql => { const m = {}; db.prepare(sql).all(...ids).forEach(x => (m[x.complaint_id] = m[x.complaint_id] || []).push(x)); return m; };
  const H = grp(`SELECT * FROM complaint_history WHERE complaint_id IN (${q}) ORDER BY id`);
  const N = grp(`SELECT * FROM complaint_notes WHERE complaint_id IN (${q}) ORDER BY id`);
  const P = grp(`SELECT * FROM complaint_photos WHERE complaint_id IN (${q}) ORDER BY id`);
  return rows.map(r => ({
    id: r.id, title: r.title, category: r.category, block: r.block, x: r.x, y: r.y, priority: r.priority, status: r.status,
    by: r.by_user, tech: r.tech, created: r.created, desc: r.description,
    history: (H[r.id] || []).map(x => ({ status: x.status, at: x.at })),
    notes: (N[r.id] || []).map(x => ({ by: x.by_user, text: x.body, at: x.at })),
    photos: (P[r.id] || []).map(x => x.path)
  }));
}
function setStatus(id, status) {
  db.prepare('UPDATE complaints SET status=? WHERE id=?').run(status, id);
  db.prepare('INSERT INTO complaint_history(complaint_id,status,at) VALUES(?,?,?)').run(id, status, new Date().toISOString());
}
function nextId(table, prefix, start) {
  const m = db.prepare(`SELECT MAX(CAST(SUBSTR(id,3) AS INTEGER)) m FROM ${table}`).get().m;
  return prefix + ((m || start) + 1);
}
function saveImages(list) {
  need(Array.isArray(list) && list.length <= 3, 'Attach at most 3 photos');
  const out = [];
  for (const d of list) {
    const s = String(d), m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,/.exec(s);
    need(m, 'Photos must be PNG, JPG, GIF or WebP');
    const buf = Buffer.from(s.slice(m[0].length), 'base64');
    need(buf.length > 0 && buf.length <= 2.5e6, 'Each photo must be under 2 MB');
    const name = crypto.randomUUID() + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    fs.writeFileSync(path.join(UPLOADS, name), buf);
    out.push('/uploads/' + name);
  }
  return out;
}

/* ---------- app ---------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); next(); });

app.get('/api/config', (req, res) => res.json({ demo: process.env.DEMO_LOGINS !== 'off' }));

/* ----- auth ----- */
app.post('/api/auth/login', h((req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  const key = req.ip + '|' + email;
  need(!limited(key), 'Too many attempts. Try again in 15 minutes.', 429);
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const ok = bcrypt.compareSync(pw, u ? u.password_hash : DUMMY_HASH) && u && u.active;
  if (!ok) { failed(key); throw new HttpError(401, 'Incorrect email or password'); }
  attempts.delete(key);
  res.json({ token: sign(u), user: pub(u, true) });
}));
app.post('/api/auth/register', h((req, res) => {
  const name = text(req.body.name, 2, 80, 'Name');
  const email = String(req.body.email || '').trim().toLowerCase();
  need(EMAIL.test(email) && email.length <= 120, 'Enter a valid email address');
  const pw = String(req.body.password || '');
  need(pw.length >= 8 && pw.length <= 100, 'Password needs at least 8 characters');
  need(!db.prepare('SELECT 1 FROM users WHERE email=?').get(email), 'An account with that email already exists', 409);
  const id = 'u' + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO users(id,name,email,password_hash,role) VALUES(?,?,?,?,?)').run(id, name, email, bcrypt.hashSync(pw, 10), 'student');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  res.json({ token: sign(u), user: pub(u, true) });
}));
app.post('/api/auth/forgot', h((req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  need(EMAIL.test(email), 'Enter a valid email address');
  const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
  if (u) notify(idsOf(['admin']), `${u.name} (${u.email}) asked for a password reset.`, '#/users');
  res.json({ ok: true }); // same answer whether or not the account exists
}));

app.get('/api/me', auth, h((req, res) => res.json({ user: pub(req.user, true) })));
app.patch('/api/me', auth, h((req, res) => {
  const name = text(req.body.name, 2, 80, 'Name');
  const phone = String(req.body.phone || '').trim();
  need(!phone || PHONE.test(phone), 'Enter a valid phone number');
  db.prepare('UPDATE users SET name=?, phone=? WHERE id=?').run(name, phone, req.user.id);
  res.json({ user: pub(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id), true) });
}));

/* ----- one call that loads everything the signed-in role may see ----- */
app.get('/api/bootstrap', auth, h((req, res) => {
  const u = req.user, wide = u.role === 'admin' || u.role === 'staff';
  const rows = wide ? db.prepare('SELECT * FROM complaints ORDER BY created DESC').all()
    : u.role === 'technician' ? db.prepare('SELECT * FROM complaints WHERE tech=? ORDER BY created DESC').all(u.id)
    : db.prepare('SELECT * FROM complaints WHERE by_user=? ORDER BY created DESC').all(u.id);
  const items = u.role !== 'technician';
  const decisions = {};
  db.prepare('SELECT * FROM decisions').all().forEach(d => { decisions[d.pair_key] = d.value; });
  res.json({
    me: pub(u, true),
    users: db.prepare('SELECT * FROM users ORDER BY rowid').all().map(x => pub(x, u.role === 'admin')),
    complaints: attach(rows),
    lost: items ? db.prepare('SELECT * FROM lost_items ORDER BY rowid DESC').all().map(toLost) : [],
    found: items ? db.prepare('SELECT * FROM found_items ORDER BY rowid DESC').all().map(toFound) : [],
    matches: items ? allMatches() : [],
    decisions: items ? decisions : {},
    categories: db.prepare('SELECT name FROM categories ORDER BY rowid').all().map(c => c.name),
    notifications: notifList(u.id)
  });
}));
const notifList = uid => db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100').all(uid)
  .map(n => ({ id: n.id, text: n.text, link: n.link, at: n.at, read: !!n.is_read }));

/* ----- complaints ----- */
app.post('/api/complaints', auth, only('student', 'staff'), h((req, res) => {
  const b = req.body;
  const title = text(b.title, 5, 120, 'Title'), desc = text(b.desc, 15, 2000, 'Description');
  need(db.prepare('SELECT 1 FROM categories WHERE name=?').get(b.category), 'Choose a valid category');
  need(PRIORITIES.includes(b.priority), 'Choose a valid priority');
  need(BLOCKS.includes(b.block), 'Pick a block on the map');
  const x = Number(b.x), y = Number(b.y);
  need(Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 610 && y >= 0 && y <= 380, 'Pick a location on the map');
  const photos = saveImages(b.photos || []);
  const now = new Date().toISOString();
  const id = db.transaction(() => {
    const id = nextId('complaints', 'C-', 1000);
    db.prepare('INSERT INTO complaints(id,title,category,block,x,y,priority,status,by_user,created,description) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, title, b.category, b.block, x, y, b.priority, 'Submitted', req.user.id, now, desc);
    db.prepare('INSERT INTO complaint_history(complaint_id,status,at) VALUES(?,?,?)').run(id, 'Submitted', now);
    photos.forEach(p => db.prepare('INSERT INTO complaint_photos(complaint_id,path) VALUES(?,?)').run(id, p));
    return id;
  })();
  notify(idsOf(['admin']), `New ${b.priority.toLowerCase()} priority complaint ${id}: ${title}`, '#/complaints/' + id, req.user.id);
  res.json({ id });
}));
function getComplaint(id) { const c = db.prepare('SELECT * FROM complaints WHERE id=?').get(id); need(c, 'Complaint not found', 404); return c; }
app.post('/api/complaints/:id/assign', auth, only('admin'), h((req, res) => {
  const c = getComplaint(req.params.id);
  need(c.status === 'Submitted' || c.status === 'Assigned', 'This complaint can no longer be reassigned');
  const t = db.prepare("SELECT * FROM users WHERE id=? AND role='technician' AND active=1").get(req.body.techId);
  need(t, 'Choose an active technician');
  db.transaction(() => {
    db.prepare('UPDATE complaints SET tech=? WHERE id=?').run(t.id, c.id);
    if (c.status === 'Submitted') setStatus(c.id, 'Assigned');
  })();
  notify([t.id], `${c.id} was assigned to you: ${c.title}`, '#/tasks/' + c.id, req.user.id);
  notify([c.by_user], `${c.id} was assigned to ${t.name}.`, '#/complaints/' + c.id, req.user.id);
  res.json({ ok: true });
}));
app.post('/api/complaints/:id/status', auth, h((req, res) => {
  const c = getComplaint(req.params.id), to = req.body.status, u = req.user;
  const isTech = u.role === 'technician' && c.tech === u.id, isAdmin = u.role === 'admin', isOwner = c.by_user === u.id;
  const ok = (isTech && c.status === 'Assigned' && to === 'In Progress')
    || (isTech && c.status === 'In Progress' && to === 'Resolved')
    || ((isOwner || isAdmin) && c.status === 'Resolved' && to === 'Closed');
  need(ok, 'That status change is not allowed', 403);
  setStatus(c.id, to);
  notify([c.by_user, c.tech], `${c.id} is now ${to}.`, '#/complaints/' + c.id, u.id);
  res.json({ ok: true });
}));
app.post('/api/complaints/:id/notes', auth, h((req, res) => {
  const c = getComplaint(req.params.id), u = req.user;
  need(u.role === 'admin' || (u.role === 'technician' && c.tech === u.id), 'Only the assigned technician or an admin can add notes', 403);
  const body = text(req.body.text, 3, 1000, 'Note');
  db.prepare('INSERT INTO complaint_notes(complaint_id,by_user,body,at) VALUES(?,?,?,?)').run(c.id, u.id, body, new Date().toISOString());
  notify([c.by_user], `New note on ${c.id}.`, '#/complaints/' + c.id, u.id);
  res.json({ ok: true });
}));

/* ----- lost and found ----- */
function reportItem(kind) {
  return h((req, res) => {
    const b = req.body, isLost = kind === 'lost';
    const title = text(b.title, 3, 100, 'Item name'), desc = text(b.desc, 10, 1000, 'Description');
    need(CATS_L.includes(b.category), 'Choose a valid category');
    need(BLOCKS.includes(b.place), 'Select a block');
    const d = new Date(b.date); need(!isNaN(d), 'Choose a valid date');
    const date = d.toISOString();
    let id;
    if (isLost) {
      id = nextId('lost_items', 'L-', 100);
      db.prepare('INSERT INTO lost_items(id,title,category,place,date,description,by_user,status) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, title, b.category, b.place, date, desc, req.user.id, 'Open');
    } else {
      need(KEPT.includes(b.kept), 'Choose where the item is kept');
      id = nextId('found_items', 'F-', 200);
      db.prepare('INSERT INTO found_items(id,title,category,place,date,description,by_user,kept,status) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, title, b.category, b.place, date, desc, req.user.id, b.kept, 'Open');
    }
    const best = allMatches().find(m => (isLost ? m.lostId : m.foundId) === id);
    if (best) {
      const lostOwner = db.prepare('SELECT by_user FROM lost_items WHERE id=?').get(best.lostId).by_user;
      notify([lostOwner], `Possible match (${best.s}%) for your lost item.`, '#/matches');
      notify(idsOf(['staff', 'admin']), `New match suggestion (${best.s}%) to review.`, '#/matches', req.user.id);
    }
    res.json({ id });
  });
}
app.post('/api/lost', auth, only('student', 'staff'), reportItem('lost'));
app.post('/api/found', auth, only('student', 'staff'), reportItem('found'));
app.post('/api/lost/:id/recover', auth, h((req, res) => {
  const i = db.prepare('SELECT * FROM lost_items WHERE id=?').get(req.params.id); need(i, 'Item not found', 404);
  need(i.by_user === req.user.id, 'Only the person who reported it can mark it as recovered', 403);
  db.prepare("UPDATE lost_items SET status='Recovered' WHERE id=?").run(i.id);
  res.json({ ok: true });
}));
app.post('/api/found/:id/claim', auth, only('student', 'staff'), h((req, res) => {
  const i = db.prepare('SELECT * FROM found_items WHERE id=?').get(req.params.id); need(i, 'Item not found', 404);
  need(i.by_user !== req.user.id, 'You reported this item, so you cannot claim it');
  need(i.status === 'Open' || i.status === 'Matched', 'This item already has a claim or was returned', 409);
  const proof = text(req.body.proof, 15, 1000, 'Proof of ownership'), phone = String(req.body.phone || '').trim();
  need(PHONE.test(phone), 'Enter a valid phone number');
  db.prepare("UPDATE found_items SET status='Claim pending', claim_by=?, claim_proof=?, claim_phone=?, claim_at=? WHERE id=?")
    .run(req.user.id, proof, phone, new Date().toISOString(), i.id);
  notify(idsOf(['staff', 'admin']), `Claim submitted for "${i.title}". Please review it.`, '#/items/found/' + i.id, req.user.id);
  res.json({ ok: true });
}));
app.post('/api/found/:id/return', auth, only('staff', 'admin'), h((req, res) => {
  const i = db.prepare('SELECT * FROM found_items WHERE id=?').get(req.params.id); need(i, 'Item not found', 404);
  need(i.status === 'Claim pending', 'There is no pending claim on this item', 409);
  db.prepare("UPDATE found_items SET status='Returned' WHERE id=?").run(i.id);
  const l = db.prepare("SELECT * FROM lost_items WHERE by_user=? AND status='Matched'").all(i.claim_by).map(toLost)
    .find(x => scorePair(x, toFound(i)).s >= THRESHOLD);
  if (l) db.prepare("UPDATE lost_items SET status='Recovered' WHERE id=?").run(l.id);
  notify([i.claim_by], `Your claim was approved. Collect "${i.title}" from the ${i.kept}.`, '#/items/found/' + i.id, req.user.id);
  res.json({ ok: true });
}));
app.post('/api/matches/decide', auth, only('staff', 'admin'), h((req, res) => {
  const [lid, fid] = String(req.body.key || '').split('|'), v = req.body.value;
  need(v === 'approved' || v === 'rejected', 'Invalid decision');
  const l = db.prepare('SELECT * FROM lost_items WHERE id=?').get(lid), f = db.prepare('SELECT * FROM found_items WHERE id=?').get(fid);
  need(l && f, 'Match not found', 404);
  need(scorePair(toLost(l), toFound(f)).s >= THRESHOLD, 'These items are not a suggested match');
  db.transaction(() => {
    db.prepare('INSERT INTO decisions(pair_key,value) VALUES(?,?) ON CONFLICT(pair_key) DO UPDATE SET value=excluded.value').run(lid + '|' + fid, v);
    if (v === 'approved') {
      db.prepare("UPDATE lost_items SET status='Matched' WHERE id=? AND status='Open'").run(lid);
      db.prepare("UPDATE found_items SET status='Matched' WHERE id=? AND status='Open'").run(fid);
    }
  })();
  if (v === 'approved') {
    notify([l.by_user], `Good news: "${l.title}" may have been found. Check your matches.`, '#/matches', req.user.id);
    notify([f.by_user], `A match was approved for "${f.title}".`, '#/items/found/' + f.id, req.user.id);
  }
  res.json({ ok: true });
}));

/* ----- admin: users + categories ----- */
app.post('/api/users', auth, only('admin'), h((req, res) => {
  const name = text(req.body.name, 2, 80, 'Name'), email = String(req.body.email || '').trim().toLowerCase(), role = req.body.role;
  need(EMAIL.test(email), 'Enter a valid email address'); need(ROLES.includes(role), 'Choose a role');
  need(!db.prepare('SELECT 1 FROM users WHERE email=?').get(email), 'An account with that email already exists', 409);
  const tempPassword = crypto.randomBytes(9).toString('base64url').slice(0, 10);
  db.prepare('INSERT INTO users(id,name,email,password_hash,role,spec) VALUES(?,?,?,?,?,?)')
    .run('u' + crypto.randomBytes(4).toString('hex'), name, email, bcrypt.hashSync(tempPassword, 10), role, role === 'technician' ? 'General maintenance' : null);
  res.json({ tempPassword });
}));
app.patch('/api/users/:id', auth, only('admin'), h((req, res) => {
  const t = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id); need(t, 'User not found', 404);
  if (req.body.role !== undefined) {
    need(ROLES.includes(req.body.role), 'Choose a valid role'); need(t.id !== req.user.id, 'You cannot change your own role');
    db.prepare('UPDATE users SET role=?, spec=COALESCE(spec, ?) WHERE id=?').run(req.body.role, req.body.role === 'technician' ? 'General maintenance' : null, t.id);
  }
  if (req.body.active !== undefined) {
    need(t.id !== req.user.id, 'You cannot deactivate your own account');
    db.prepare('UPDATE users SET active=? WHERE id=?').run(req.body.active ? 1 : 0, t.id);
  }
  res.json({ ok: true });
}));
app.post('/api/users/:id/reset-password', auth, only('admin'), h((req, res) => {
  const t = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id); need(t, 'User not found', 404);
  const tempPassword = crypto.randomBytes(9).toString('base64url').slice(0, 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(tempPassword, 10), t.id);
  res.json({ tempPassword });
}));
app.post('/api/categories', auth, only('admin'), h((req, res) => {
  const name = text(req.body.name, 3, 40, 'Category name');
  need(!db.prepare('SELECT 1 FROM categories WHERE LOWER(name)=LOWER(?)').get(name), 'That category already exists', 409);
  db.prepare('INSERT INTO categories(name) VALUES(?)').run(name); res.json({ ok: true });
}));
app.delete('/api/categories/:name', auth, only('admin'), h((req, res) => {
  need(!db.prepare('SELECT 1 FROM complaints WHERE category=?').get(req.params.name), 'That category is used by complaints', 409);
  db.prepare('DELETE FROM categories WHERE name=?').run(req.params.name); res.json({ ok: true });
}));

/* ----- notifications ----- */
app.get('/api/notifications', auth, h((req, res) => res.json({ notifications: notifList(req.user.id) })));
app.post('/api/notifications/read', auth, h((req, res) => {
  if (req.body.all) db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.user.id);
  else db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=? AND id=?').run(req.user.id, Number(req.body.id));
  res.json({ ok: true });
}));

/* ---------- static + errors ---------- */
app.use('/uploads', express.static(UPLOADS, { index: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body' });
  console.error(err); res.status(500).json({ error: 'Something went wrong on the server' });
});

app.listen(PORT, () => console.log(`Smart Campus running at http://localhost:${PORT}`));
