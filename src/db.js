'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.13+, nothing to compile
const bcrypt = require('bcryptjs');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'campus.db');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const raw = new DatabaseSync(DB_FILE);
// Small wrapper so the rest of the code can use prepare/transaction/exec
const db = {
  exec: sql => raw.exec(sql),
  prepare: sql => {
    const st = raw.prepare(sql);
    return { run: (...a) => st.run(...a), get: (...a) => st.get(...a), all: (...a) => st.all(...a) };
  },
  transaction: fn => (...a) => {
    raw.exec('BEGIN');
    try { const r = fn(...a); raw.exec('COMMIT'); return r; } catch (e) { raw.exec('ROLLBACK'); throw e; }
  }
};
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('student','staff','technician','admin')),
  spec TEXT, phone TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS categories(name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS complaints(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, block TEXT NOT NULL, x REAL, y REAL,
  priority TEXT NOT NULL, status TEXT NOT NULL, by_user TEXT NOT NULL REFERENCES users(id),
  tech TEXT REFERENCES users(id), created TEXT NOT NULL, description TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_complaints_by ON complaints(by_user);
CREATE INDEX IF NOT EXISTS idx_complaints_tech ON complaints(tech);
CREATE TABLE IF NOT EXISTS complaint_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT, complaint_id TEXT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  status TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS complaint_notes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, complaint_id TEXT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  by_user TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS complaint_photos(
  id INTEGER PRIMARY KEY AUTOINCREMENT, complaint_id TEXT NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  path TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lost_items(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, place TEXT NOT NULL, date TEXT NOT NULL,
  description TEXT NOT NULL, by_user TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS found_items(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, place TEXT NOT NULL, date TEXT NOT NULL,
  description TEXT NOT NULL, by_user TEXT NOT NULL REFERENCES users(id), kept TEXT NOT NULL, status TEXT NOT NULL,
  claim_by TEXT, claim_proof TEXT, claim_phone TEXT, claim_at TEXT);
CREATE TABLE IF NOT EXISTS decisions(pair_key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL, link TEXT, at TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, id);
`);

const DEFAULT_CATS = ['Electrical', 'Plumbing', 'Network / Wi-Fi', 'Furniture', 'Cleaning', 'Roads & Parking', 'Air conditioning', 'Safety'];
const BLOCKS = {
  A: [40, 30, 150, 80], B: [230, 30, 190, 90], C: [460, 30, 110, 90], D: [40, 150, 110, 80], E: [190, 160, 120, 70],
  F: [350, 150, 220, 90], G: [40, 270, 200, 80], H: [280, 280, 130, 70], I: [450, 280, 120, 70]
};
const BLOCK_NAMES = { A: 'Admin Block', B: 'Engineering Block', C: 'Library', D: 'Auditorium', E: 'Canteen', F: 'Hostel', G: 'Sports Complex', H: 'Parking', I: 'Main Gate' };
const STATUSES = ['Submitted', 'Assigned', 'In Progress', 'Resolved', 'Closed'];

function seedDemo() {
  const now = Date.now(), DAY = 864e5, ago = d => new Date(now - d * DAY).toISOString();
  const pw = bcrypt.hashSync('campus123', 10);
  const U = [
    ['u1', 'Nikish M', 'nikish@campus.edu', 'student'], ['u2', 'Ananya R', 'ananya@campus.edu', 'student'],
    ['u3', 'Dr. Meera S', 'meera@campus.edu', 'staff'], ['u4', 'Karthik P', 'karthik@campus.edu', 'staff'],
    ['t1', 'Ravi Kumar', 'ravi@campus.edu', 'technician', 'Electrical'], ['t2', 'Suresh B', 'suresh@campus.edu', 'technician', 'Plumbing'],
    ['t3', 'Lakshmi D', 'lakshmi@campus.edu', 'technician', 'Network / Wi-Fi'], ['t4', 'Imran A', 'imran@campus.edu', 'technician', 'General maintenance'],
    ['a1', 'Priya Nair', 'priya@campus.edu', 'admin']];
  const insU = db.prepare('INSERT INTO users(id,name,email,password_hash,role,spec) VALUES(?,?,?,?,?,?)');
  U.forEach(u => insU.run(u[0], u[1], u[2], pw, u[3], u[4] || null));

  const techFor = c => c === 'Electrical' ? 't1' : c === 'Plumbing' ? 't2' : c === 'Network / Wi-Fi' ? 't3' : 't4';
  const seedC = [
    ['Flickering tube lights in Lab 3', 'Electrical', 'B', 'Medium'], ['Water leak near washroom', 'Plumbing', 'F', 'High'],
    ['Wi-Fi drops in reading hall', 'Network / Wi-Fi', 'C', 'Medium'], ['Broken bench near canteen', 'Furniture', 'E', 'Low'],
    ['Overflowing dustbins', 'Cleaning', 'E', 'Medium'], ['Pothole at parking entrance', 'Roads & Parking', 'H', 'High'],
    ['AC not cooling in seminar hall', 'Air conditioning', 'D', 'Medium'], ['Exposed wiring in corridor', 'Safety', 'A', 'Urgent'],
    ['Tap not working on second floor', 'Plumbing', 'F', 'Medium'], ['Projector not turning on', 'Electrical', 'B', 'Medium'],
    ['Street light out near main gate', 'Electrical', 'I', 'High'], ['Slow internet in hostel', 'Network / Wi-Fi', 'F', 'Low'],
    ['Cracked floor tile outside library', 'Safety', 'C', 'Medium'], ['Water cooler out of order', 'Plumbing', 'G', 'Low'],
    ['Gate barrier stuck', 'Roads & Parking', 'I', 'Medium'], ['Broken chairs in classroom 204', 'Furniture', 'B', 'Low'],
    ['Fan making loud noise', 'Electrical', 'A', 'Low'], ['Washroom needs cleaning', 'Cleaning', 'G', 'Medium']];
  const seedSt = [0, 0, 1, 1, 2, 0, 2, 3, 2, 3, 3, 4, 3, 4, 4, 3, 4, 4];
  const insC = db.prepare('INSERT INTO complaints(id,title,category,block,x,y,priority,status,by_user,tech,created,description) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const insH = db.prepare('INSERT INTO complaint_history(complaint_id,status,at) VALUES(?,?,?)');
  const insN = db.prepare('INSERT INTO complaint_notes(complaint_id,by_user,body,at) VALUES(?,?,?,?)');
  seedC.forEach((r, i) => {
    const [bx, by, bw, bh] = BLOCKS[r[2]], st = seedSt[i], created = now - (i * 3.1 + 0.4) * DAY;
    const hist = [];
    for (let k = 0; k <= st; k++) hist.push({ status: STATUSES[k], at: new Date(Math.min(now - 6e4, created + k * (0.4 + (i % 4) * 0.35) * DAY)).toISOString() });
    const id = 'C-' + (1001 + i), tech = st >= 1 ? techFor(r[1]) : null;
    insC.run(id, r[0], r[1], r[2], bx + 10 + (i * 37) % (bw - 20), by + 22 + (i * 53) % (bh - 34), r[3], STATUSES[st],
      ['u1', 'u2', 'u3', 'u4'][i % 4], tech, hist[0].at, 'Reported near ' + BLOCK_NAMES[r[2]] + '. ' + r[0] + ' has been affecting daily use for a few days.');
    hist.forEach(h => insH.run(id, h.status, h.at));
    if (st >= 2) insN.run(id, tech, 'Inspected the spot and started the repair.', hist[2].at);
  });

  const insL = db.prepare('INSERT INTO lost_items(id,title,category,place,date,description,by_user,status) VALUES(?,?,?,?,?,?,?,?)');
  [['L-101', 'Black Boat headphones', 'Electronics', 'C', 3, 'Black over-ear headphones in a soft pouch.', 'u1'],
   ['L-102', 'Blue water bottle', 'Other', 'G', 5, 'Blue bottle with a dent near the base.', 'u2'],
   ['L-103', 'College ID card', 'ID / Cards', 'E', 2, 'ID card with a blue lanyard, name Ananya R.', 'u2'],
   ['L-104', 'Silver Casio calculator', 'Electronics', 'B', 6, 'Scientific calculator with initials NM on the back.', 'u1'],
   ['L-105', 'Red backpack with notebooks', 'Bags', 'F', 1, 'Red backpack, three notebooks and a pencil case inside.', 'u4'],
   ['L-106', 'Bike key with green keychain', 'Keys', 'H', 4, 'Single bike key on a green keychain.', 'u3']]
    .forEach(r => insL.run(r[0], r[1], r[2], r[3], ago(r[4]), r[5], r[6], 'Open'));
  const insF = db.prepare('INSERT INTO found_items(id,title,category,place,date,description,by_user,kept,status) VALUES(?,?,?,?,?,?,?,?,?)');
  [['F-201', 'Black wireless headphones', 'Electronics', 'C', 2, 'Found on a table in the reading hall.', 'u3', 'Library desk'],
   ['F-202', 'Student ID card', 'ID / Cards', 'E', 2, 'ID card with a blue lanyard left at the counter.', 'u4', 'Security desk'],
   ['F-203', 'Blue steel bottle', 'Other', 'G', 4, 'Blue bottle left on the bleachers.', 'u3', 'Sports office'],
   ['F-204', 'Grey scientific calculator', 'Electronics', 'B', 5, 'Calculator found in the Lab 2 corridor.', 'u4', 'Admin Block'],
   ['F-205', 'Black umbrella', 'Other', 'A', 3, 'Folding umbrella near the admin entrance.', 'u3', 'Security desk'],
   ['F-206', 'Set of keys with green tag', 'Keys', 'I', 3, 'Two keys on a ring with a green tag.', 'u4', 'Security desk']]
    .forEach(r => insF.run(r[0], r[1], r[2], r[3], ago(r[4]), r[5], r[6], r[7], 'Open'));

  const insNo = db.prepare('INSERT INTO notifications(user_id,text,link,at,is_read) VALUES(?,?,?,?,?)');
  insNo.run('u1', 'Welcome to Smart Campus. Report an issue or a lost item to get started.', '#/dashboard', ago(0.3), 0);
  insNo.run('u1', 'A possible match was found for your lost headphones.', '#/matches', ago(0.2), 0);
}

function init() {
  const insCat = db.prepare('INSERT OR IGNORE INTO categories(name) VALUES(?)');
  if (db.prepare('SELECT COUNT(*) c FROM categories').get().c === 0) DEFAULT_CATS.forEach(c => insCat.run(c));
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return;
  if (process.env.SEED !== 'off') { seedDemo(); console.log('Seeded demo data (all demo accounts use the password "campus123").'); return; }
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase(), pw = process.env.ADMIN_PASSWORD || '';
  if (email && pw.length >= 8) {
    db.prepare('INSERT INTO users(id,name,email,password_hash,role) VALUES(?,?,?,?,?)')
      .run('a' + crypto.randomBytes(4).toString('hex'), 'Administrator', email, bcrypt.hashSync(pw, 10), 'admin');
    console.log('Created first admin account for ' + email);
  } else console.warn('[warn] Database is empty and no ADMIN_EMAIL / ADMIN_PASSWORD (8+ chars) was provided, so nobody can sign in.');
}
db.transaction(init)();

module.exports = db;
