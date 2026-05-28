'use strict';
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const initSqlJs = require('sql.js');
const fs       = require('fs');
const path     = require('path');
const PORT    = 3000;
const DB_PATH = path.join(__dirname, 'ppd2026.db');

// ── Bootstrap DB ──────────────────────────────────────────
let db;
async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS scores (
    daerah    TEXT NOT NULL,
    penilai   TEXT NOT NULL,
    ind_id    INTEGER NOT NULL,
    sub_idx   INTEGER NOT NULL,
    score     INTEGER,           -- 0, 1, or NULL
    updated   TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (daerah, penilai, ind_id, sub_idx)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS justifications (
    daerah    TEXT NOT NULL,
    penilai   TEXT NOT NULL,
    ind_id    INTEGER NOT NULL,
    sub_idx   INTEGER NOT NULL,
    notes     TEXT DEFAULT '',
    updated   TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (daerah, penilai, ind_id, sub_idx)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS attachments (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    daerah    TEXT NOT NULL,
    penilai   TEXT NOT NULL,
    ind_id    INTEGER NOT NULL,
    sub_idx   INTEGER NOT NULL,
    filename  TEXT NOT NULL,
    mimetype  TEXT NOT NULL,
    size      INTEGER NOT NULL,
    data      BLOB NOT NULL,
    uploaded  TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS prapleno (
    daerah    TEXT NOT NULL,
    key       TEXT NOT NULL,
    val       TEXT NOT NULL,
    updated   TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (daerah, key)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS passwords (
    user_key  TEXT PRIMARY KEY,
    password  TEXT NOT NULL,
    updated   TEXT DEFAULT (datetime('now'))
  )`);

  // Seed default admin password
  db.run(`INSERT OR IGNORE INTO passwords(user_key,password) VALUES('__admin__','123456')`);

  persist();
  console.log('[DB] Initialized OK');
}

// Flush DB to disk after every write
function persist() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch(e) { console.error('[DB] persist error:', e.message); }
}

// ── Express Setup ──────────────────────────────────────────
const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve the PPD HTML app at root
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'ppd_app.html');
  if (fs.existsSync(htmlPath)) res.sendFile(htmlPath);
  else res.send('<h2>ppd_app.html not found.</h2>');
});

// ── API: Passwords ─────────────────────────────────────────
// GET: verify password for a user_key
app.post('/api/auth', (req, res) => {
  const { user_key, password } = req.body;
  if (!user_key || !password) return res.status(400).json({ ok: false, error: 'missing fields' });
  const rows = db.exec('SELECT password FROM passwords WHERE user_key=?', [user_key]);
  if (!rows[0] || !rows[0].values[0]) {
    // User not in DB → use global default PASS
    const defRows = db.exec("SELECT password FROM passwords WHERE user_key='__default__'");
    const defPass = defRows[0]?.values[0]?.[0] || '123456';
    return res.json({ ok: password === defPass });
  }
  const stored = rows[0].values[0][0];
  res.json({ ok: password === stored });
});

// GET: list all custom passwords (admin only, returns keys)
app.get('/api/passwords', (req, res) => {
  const rows = db.exec('SELECT user_key, password FROM passwords ORDER BY user_key');
  const out = {};
  if (rows[0]) rows[0].values.forEach(([k,v]) => { out[k] = v; });
  res.json(out);
});

// POST: set password for a user_key
app.post('/api/passwords', (req, res) => {
  const { user_key, password } = req.body;
  if (!user_key || !password) return res.status(400).json({ ok: false, error: 'missing fields' });
  db.run(
    `INSERT INTO passwords(user_key,password,updated) VALUES(?,?,datetime('now'))
     ON CONFLICT(user_key) DO UPDATE SET password=excluded.password,updated=excluded.updated`,
    [user_key, password]
  );
  persist();
  res.json({ ok: true });
});

// GET: input progress per penilai per daerah (for green dot indicator)
app.get('/api/progress', (req, res) => {
  const rows = db.exec(
    `SELECT daerah, penilai, COUNT(*) as cnt
     FROM scores WHERE score IS NOT NULL
     GROUP BY daerah, penilai`
  );
  const out = {};
  if (rows[0]) {
    rows[0].values.forEach(([d,p,cnt]) => {
      if (!out[d]) out[d] = {};
      out[d][p] = cnt;
    });
  }
  res.json(out);
});

// ── API: Scores ────────────────────────────────────────────

// GET all scores for daerah+penilai
app.get('/api/scores', (req, res) => {
  const { daerah, penilai } = req.query;
  if (!daerah || !penilai) return res.status(400).json({ error: 'daerah & penilai required' });
  const rows = db.exec(
    'SELECT ind_id, sub_idx, score FROM scores WHERE daerah=? AND penilai=?',
    [daerah, penilai]
  );
  const result = {};
  if (rows[0]) {
    rows[0].values.forEach(([ind_id, sub_idx, score]) => {
      result[`${ind_id}__${sub_idx}`] = score;
    });
  }
  res.json(result);
});

// POST upsert a single score
app.post('/api/scores', (req, res) => {
  const { daerah, penilai, ind_id, sub_idx, score } = req.body;
  if (!daerah || !penilai || ind_id == null || sub_idx == null) return res.status(400).json({ error: 'missing fields' });
  db.run(
    `INSERT INTO scores (daerah,penilai,ind_id,sub_idx,score,updated)
     VALUES (?,?,?,?,?,datetime('now'))
     ON CONFLICT(daerah,penilai,ind_id,sub_idx) DO UPDATE SET score=excluded.score, updated=excluded.updated`,
    [daerah, penilai, ind_id, sub_idx, score ?? null]
  );
  persist();
  res.json({ ok: true });
});

// ── API: Justifications (notes) ────────────────────────────

// GET justifications for daerah+penilai
app.get('/api/justifications', (req, res) => {
  const { daerah, penilai } = req.query;
  if (!daerah || !penilai) return res.status(400).json({ error: 'daerah & penilai required' });
  const rows = db.exec(
    'SELECT ind_id, sub_idx, notes FROM justifications WHERE daerah=? AND penilai=?',
    [daerah, penilai]
  );
  const result = {};
  if (rows[0]) {
    rows[0].values.forEach(([ind_id, sub_idx, notes]) => {
      result[`${ind_id}__${sub_idx}`] = { notes };
    });
  }
  res.json(result);
});

// POST upsert notes for one sub
app.post('/api/justifications', (req, res) => {
  const { daerah, penilai, ind_id, sub_idx, notes } = req.body;
  if (!daerah || !penilai || ind_id == null || sub_idx == null) return res.status(400).json({ error: 'missing fields' });
  db.run(
    `INSERT INTO justifications (daerah,penilai,ind_id,sub_idx,notes,updated)
     VALUES (?,?,?,?,?,datetime('now'))
     ON CONFLICT(daerah,penilai,ind_id,sub_idx) DO UPDATE SET notes=excluded.notes, updated=excluded.updated`,
    [daerah, penilai, ind_id, sub_idx, notes || '']
  );
  persist();
  res.json({ ok: true });
});

// ── API: Attachments ───────────────────────────────────────

// GET list of attachments for a sub
app.get('/api/attachments', (req, res) => {
  const { daerah, penilai, ind_id, sub_idx } = req.query;
  if (!daerah || !penilai || ind_id == null || sub_idx == null) return res.status(400).json({ error: 'missing fields' });
  const rows = db.exec(
    'SELECT id, filename, mimetype, size, uploaded FROM attachments WHERE daerah=? AND penilai=? AND ind_id=? AND sub_idx=? ORDER BY id',
    [daerah, penilai, Number(ind_id), Number(sub_idx)]
  );
  const result = [];
  if (rows[0]) {
    rows[0].values.forEach(([id, filename, mimetype, size, uploaded]) => {
      result.push({ id, filename, mimetype, size, uploaded });
    });
  }
  res.json(result);
});

// POST upload one or more files
app.post('/api/attachments', upload.array('files'), (req, res) => {
  const { daerah, penilai, ind_id, sub_idx } = req.body;
  if (!daerah || !penilai || ind_id == null || sub_idx == null) return res.status(400).json({ error: 'missing fields' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'no files' });

  const ids = [];
  const stmt = db.prepare(
    'INSERT INTO attachments (daerah,penilai,ind_id,sub_idx,filename,mimetype,size,data) VALUES (?,?,?,?,?,?,?,?)'
  );
  req.files.forEach(f => {
    stmt.run([daerah, penilai, Number(ind_id), Number(sub_idx), f.originalname, f.mimetype, f.size, f.buffer]);
    const last = db.exec('SELECT last_insert_rowid()');
    if (last[0]) ids.push(last[0].values[0][0]);
  });
  stmt.free();
  persist();
  res.json({ ok: true, ids });
});

// GET download one attachment
app.get('/api/attachments/:id', (req, res) => {
  const rows = db.exec('SELECT filename, mimetype, data FROM attachments WHERE id=?', [Number(req.params.id)]);
  if (!rows[0] || !rows[0].values[0]) return res.status(404).json({ error: 'not found' });
  const [filename, mimetype, data] = rows[0].values[0];
  res.setHeader('Content-Type', mimetype);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
  res.send(Buffer.from(data));
});

// DELETE one attachment
app.delete('/api/attachments/:id', (req, res) => {
  db.run('DELETE FROM attachments WHERE id=?', [Number(req.params.id)]);
  persist();
  res.json({ ok: true });
});

// ── API: Pra-Pleno ─────────────────────────────────────────

app.get('/api/prapleno', (req, res) => {
  const { daerah } = req.query;
  if (!daerah) return res.status(400).json({ error: 'daerah required' });
  const rows = db.exec('SELECT key, val FROM prapleno WHERE daerah=?', [daerah]);
  const result = {};
  if (rows[0]) rows[0].values.forEach(([k, v]) => { try { result[k] = JSON.parse(v); } catch { result[k] = v; } });
  res.json(result);
});

app.post('/api/prapleno', (req, res) => {
  const { daerah, key, val } = req.body;
  if (!daerah || !key) return res.status(400).json({ error: 'missing fields' });
  db.run(
    `INSERT INTO prapleno (daerah,key,val,updated) VALUES (?,?,?,datetime('now'))
     ON CONFLICT(daerah,key) DO UPDATE SET val=excluded.val, updated=excluded.updated`,
    [daerah, key, typeof val === 'string' ? val : JSON.stringify(val)]
  );
  persist();
  res.json({ ok: true });
});

// ── API: Summary (for rekap tab) ───────────────────────────
app.get('/api/summary', (req, res) => {
  const { daerah } = req.query;
  if (!daerah) return res.status(400).json({ error: 'daerah required' });
  const rows = db.exec(
    'SELECT penilai, ind_id, sub_idx, score FROM scores WHERE daerah=? AND score IS NOT NULL ORDER BY penilai, ind_id, sub_idx',
    [daerah]
  );
  const result = {};
  if (rows[0]) {
    rows[0].values.forEach(([penilai, ind_id, sub_idx, score]) => {
      if (!result[penilai]) result[penilai] = {};
      result[penilai][`${ind_id}__${sub_idx}`] = score;
    });
  }
  res.json(result);
});

// ── Start ──────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✅ Server PPD 2026 berjalan di http://localhost:${PORT}`);
    console.log(`   Database: ${DB_PATH}`);
    console.log(`   Letakkan file HTML sebagai "ppd_app.html" di folder ini.\n`);
  });
}).catch(e => { console.error('Fatal:', e); process.exit(1); });
