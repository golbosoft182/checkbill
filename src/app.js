const express = require('express');
const path = require('path');
const session = require('express-session');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const csrf = require('csurf');
const rateLimit = require('express-rate-limit');
const { body } = require('express-validator');
const bcrypt = require('bcryptjs');
const expressLayouts = require('express-ejs-layouts');
const { initPool, initSchemaAndSeed } = require('./db');
const { loadConfig, saveConfig } = require('./config');
const { startScheduler } = require('./scheduler');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "img-src": ["'self'", "data:", "https:"],
      "style-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      "script-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      "font-src": ["'self'", "https://cdn.jsdelivr.net"],
    }
  }
}));
app.use(cookieParser());

let pool;
const cfg = loadConfig();

app.use(session({
  secret: process.env.SESSION_SECRET || 'checkbill-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  }
}));

const csrfProtection = csrf({ cookie: true });
app.use(csrfProtection);
app.use((req, res, next) => { res.locals.csrfToken = req.csrfToken(); next(); });

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/login', loginLimiter);

app.use((req, res, next) => {
  const runtimeCfg = loadConfig();
  res.locals.user = req.session.user || null;
  res.locals.role = req.session.user ? req.session.user.role : null;
  res.locals.isSuper = req.session.user && req.session.user.role === 'super_admin';
  res.locals.isAdmin = req.session.user && (req.session.user.role === 'admin' || req.session.user.role === 'super_admin');
  res.locals.currentPath = req.path;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireInstalled(req, res, next) {
  const runtimeCfg = loadConfig();
  if (!runtimeCfg.installed) {
    const allowStatic = req.path.startsWith('/css') || req.path.startsWith('/js') || req.path.startsWith('/images');
    if (req.path === '/setup' || req.path === '/health' || allowStatic) return next();
    return res.redirect('/setup');
  }
  next();
}

app.use(requireInstalled);

function requireSuper(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'super_admin') return res.status(403).send('Akses super admin diperlukan');
  next();
}

app.get('/', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const upcomingWindow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const [rows] = await pool.query(
      `SELECT r.*, c.name AS company_name, c.type AS company_type
       FROM reminders r
       JOIN companies c ON c.id = r.company_id
       WHERE r.status='active' AND r.next_run <= ?
       ORDER BY r.next_run ASC`,
      [upcomingWindow]
    );
    res.render('index', { alerts: rows, now });
  } catch (e) {
    res.status(500).send('Database not ready: ' + e.message);
  }
});

app.get('/companies', requireAuth, async (req, res) => {
  const [companies] = await pool.query('SELECT * FROM companies ORDER BY created_at DESC');
  res.render('companies', { companies });
});

app.get('/companies/new', requireAuth, (req, res) => {
  res.render('company_form', { company: null });
});

app.post('/companies/new', requireAuth,
  body('name').trim().isLength({ min: 2 }),
  body('type').isIn(['company','hospital']),
  body('email').optional({ checkFalsy: true }).isEmail(),
  body('phone').optional({ checkFalsy: true }).trim(),
  async (req, res) => {
    const { name, type, email, phone } = req.body;
    await pool.query('INSERT INTO companies (name, type, email, phone) VALUES (?,?,?,?)', [name, type, email || null, phone || null]);
    res.redirect('/companies');
});

app.get('/companies/:id/edit', requireAuth, async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query('SELECT * FROM companies WHERE id = ?', [id]);
  const company = rows[0];
  if (!company) return res.redirect('/companies');
  res.render('company_form', { company });
});

app.post('/companies/:id/edit', requireAuth,
  body('name').trim().isLength({ min: 2 }),
  body('type').isIn(['company','hospital']),
  body('email').optional({ checkFalsy: true }).isEmail(),
  body('phone').optional({ checkFalsy: true }).trim(),
  async (req, res) => {
    const { id } = req.params;
    const { name, type, email, phone } = req.body;
    await pool.query('UPDATE companies SET name=?, type=?, email=?, phone=? WHERE id=?', [name, type, email || null, phone || null, id]);
    res.redirect('/companies');
});

app.post('/companies/:id/delete', requireSuper, async (req, res) => {
  const { id } = req.params;
  await pool.query('DELETE FROM companies WHERE id = ?', [id]);
  res.redirect('/companies');
});

app.get('/reminders', requireAuth, async (req, res) => {
  const [reminders] = await pool.query(
    `SELECT r.*, c.name AS company_name FROM reminders r JOIN companies c ON c.id = r.company_id ORDER BY r.next_run ASC`
  );
  res.render('reminders', { reminders });
});

app.get('/reminders/new', requireAuth, async (req, res) => {
  const [companies] = await pool.query('SELECT * FROM companies ORDER BY name ASC');
  res.render('reminder_form', { companies, reminder: null });
});

app.post('/reminders/new', requireAuth,
  body('company_id').isInt({ min: 1 }),
  body('title').trim().isLength({ min: 2 }),
  body('due_date').isISO8601(),
  body('due_time').matches(/^\d{2}:\d{2}$/),
  body('frequency').isIn(['once','daily','weekly','monthly','yearly']),
  async (req, res) => {
    const { company_id, title, due_date, due_time, frequency, notes } = req.body;
    const nextRun = new Date(`${due_date}T${due_time}:00`);
    await pool.query(
      'INSERT INTO reminders (company_id, title, due_date, due_time, frequency, next_run, status, notes) VALUES (?,?,?,?,?,?,"active",?)',
      [company_id, title, due_date, due_time, frequency, nextRun, notes || null]
    );
    res.redirect('/reminders');
});

app.get('/reminders/:id/edit', requireAuth, async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query('SELECT * FROM reminders WHERE id = ?', [id]);
  const reminder = rows[0];
  if (!reminder) return res.redirect('/reminders');
  const [companies] = await pool.query('SELECT * FROM companies ORDER BY name ASC');
  res.render('reminder_form', { companies, reminder });
});

app.post('/reminders/:id/edit', requireAuth,
  body('company_id').isInt({ min: 1 }),
  body('title').trim().isLength({ min: 2 }),
  body('due_date').isISO8601(),
  body('due_time').matches(/^\d{2}:\d{2}$/),
  body('frequency').isIn(['once','daily','weekly','monthly','yearly']),
  async (req, res) => {
    const { id } = req.params;
    const { company_id, title, due_date, due_time, frequency, notes } = req.body;
    const nextRun = new Date(`${due_date}T${due_time}:00`);
    await pool.query('UPDATE reminders SET company_id=?, title=?, due_date=?, due_time=?, frequency=?, next_run=?, notes=? WHERE id=?', [company_id, title, due_date, due_time, frequency, nextRun, notes || null, id]);
    res.redirect('/reminders');
});

app.post('/reminders/:id/delete', requireSuper, async (req, res) => {
  const { id } = req.params;
  await pool.query('DELETE FROM reminders WHERE id = ?', [id]);
  res.redirect('/reminders');
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/setup', (req, res) => {
  if (cfg.installed) return res.redirect('/');
  res.render('setup', { error: null, values: { mysql_host: cfg.mysql_host, mysql_user: cfg.mysql_user, mysql_password: cfg.mysql_password, mysql_db: cfg.mysql_db } });
});

app.post('/setup', async (req, res) => {
  const { mysql_host, mysql_user, mysql_password, mysql_db, license_code, admin_username, admin_password } = req.body;
  try {
    const newCfg = { ...cfg, mysql_host, mysql_user, mysql_password, mysql_db };
    saveConfig(newCfg);
    // Initialize DB with new config
    pool = null; // reset
    await initSchemaAndSeed();
    // Validate license
    const [lrows] = await (await initPool()).query('SELECT * FROM license_keys WHERE code = ? AND status != "revoked"', [license_code]);
    if (lrows.length === 0) {
      return res.render('setup', { error: 'Kode beli tidak valid. Hubungi programmer via WhatsApp +62 821-3940-3434 untuk kode yang benar.', values: { mysql_host, mysql_user, mysql_password, mysql_db } });
    }
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(admin_password, 10);
    const p = await initPool();
    // Create admin user if not exists
    const [u] = await p.query('SELECT * FROM users WHERE username = ?', [admin_username]);
    if (u.length === 0) {
      await p.query('INSERT INTO users (username, password_hash) VALUES (?,?)', [admin_username, hash]);
    }
    // Activate license
    await p.query('UPDATE license_keys SET status="active", used_at=NOW() WHERE code = ?', [license_code]);
    await p.query('UPDATE app_settings SET installed=1, license_code=? WHERE id=1', [license_code]);
    newCfg.installed = true;
    newCfg.license_code = license_code;
    newCfg.admin_username = admin_username;
    saveConfig(newCfg);
    Object.assign(cfg, newCfg);
    pool = await initPool();
    await startScheduler(pool);
    res.redirect('/login');
  } catch (e) {
    res.render('setup', { error: 'Gagal setup: ' + e.message, values: { mysql_host, mysql_user, mysql_password, mysql_db } });
  }
});

app.get('/transactions', requireAuth, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT t.*, c.name AS company_name FROM transactions t JOIN companies c ON c.id = t.company_id ORDER BY t.created_at DESC`
  );
  res.render('transactions', { transactions: rows });
});

app.get('/transactions/new', requireAuth, async (req, res) => {
  const [companies] = await pool.query('SELECT * FROM companies ORDER BY name ASC');
  res.render('transaction_form', { companies, trx: null });
});

app.post('/transactions/new', requireAuth,
  body('company_id').isInt({ min: 1 }),
  body('title').trim().isLength({ min: 2 }),
  body('amount').isFloat({ min: 0 }),
  body('trx_date').isISO8601(),
  body('status').isIn(['pending','paid','overdue']),
  async (req, res) => {
    const { company_id, title, amount, trx_date, status } = req.body;
    await pool.query(
      'INSERT INTO transactions (company_id, title, amount, trx_date, status) VALUES (?,?,?,?,?)',
      [company_id, title, amount, trx_date, status]
    );
    res.redirect('/transactions');
});

app.get('/transactions/:id/edit', requireAuth, async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query('SELECT * FROM transactions WHERE id = ?', [id]);
  const trx = rows[0];
  if (!trx) return res.redirect('/transactions');
  const [companies] = await pool.query('SELECT * FROM companies ORDER BY name ASC');
  res.render('transaction_form', { companies, trx });
});

app.post('/transactions/:id/edit', requireAuth,
  body('company_id').isInt({ min: 1 }),
  body('title').trim().isLength({ min: 2 }),
  body('amount').isFloat({ min: 0 }),
  body('trx_date').isISO8601(),
  body('status').isIn(['pending','paid','overdue']),
  async (req, res) => {
    const { id } = req.params;
    const { company_id, title, amount, trx_date, status } = req.body;
    await pool.query('UPDATE transactions SET company_id=?, title=?, amount=?, trx_date=?, status=? WHERE id=?', [company_id, title, amount, trx_date, status, id]);
    res.redirect('/transactions');
});

app.post('/transactions/:id/delete', requireSuper, async (req, res) => {
  const { id } = req.params;
  await pool.query('DELETE FROM transactions WHERE id = ?', [id]);
  res.redirect('/transactions');
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
  const user = rows[0];
  if (!user) return res.render('login', { error: 'User tidak ditemukan' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.render('login', { error: 'Password salah' });
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/admin/licenses', requireSuper, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM license_keys ORDER BY created_at DESC');
  res.render('admin_licenses', { licenses: rows });
});

app.get('/admin/licenses/new', requireSuper, (req, res) => {
  res.render('admin_license_form', { error: null });
});

app.post('/admin/licenses/new', requireSuper, async (req, res) => {
  const { code, note } = req.body;
  try {
    await pool.query('INSERT INTO license_keys (code, status, note) VALUES (?,"unused",?)', [code, note || null]);
    res.redirect('/admin/licenses');
  } catch (e) {
    res.render('admin_license_form', { error: e.message });
  }
});

app.post('/admin/licenses/:id/revoke', requireSuper, async (req, res) => {
  const { id } = req.params;
  await pool.query('UPDATE license_keys SET status="revoked" WHERE id = ?', [id]);
  res.redirect('/admin/licenses');
});

app.get('/admin/users', requireSuper, async (req, res) => {
  const [rows] = await pool.query('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC');
  res.render('admin_users', { users: rows, error: null });
});

app.get('/admin/users/new', requireSuper, (req, res) => {
  res.render('admin_user_form', { error: null });
});

app.post('/admin/users/new', requireSuper, async (req, res) => {
  const { username, password, role } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)', [username, hash, role]);
    res.redirect('/admin/users');
  } catch (e) {
    res.render('admin_user_form', { error: e.message });
  }
});

app.post('/admin/users/:id/delete', requireSuper, async (req, res) => {
  const { id } = req.params;
  await pool.query('DELETE FROM users WHERE id = ?', [id]);
  res.redirect('/admin/users');
});

async function start() {
  try {
    if (cfg.installed) {
      pool = await initPool();
      await initSchemaAndSeed();
      await startScheduler(pool);
    }
  } catch (e) {
    console.error('DB init error', e);
  }
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start();
