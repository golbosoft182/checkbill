const mysql = require('mysql2/promise');
const { loadConfig } = require('./config');

let pool;

async function ensureDatabase() {
  const cfg = loadConfig();
  const conn = await mysql.createConnection({
    host: cfg.mysql_host,
    user: cfg.mysql_user,
    password: cfg.mysql_password,
    multipleStatements: true,
  });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${cfg.mysql_db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  await conn.end();
}

async function initPool() {
  if (pool) return pool;
  await ensureDatabase();
  const cfg = loadConfig();
  pool = await mysql.createPool({
    host: cfg.mysql_host,
    user: cfg.mysql_user,
    password: cfg.mysql_password,
    database: cfg.mysql_db,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    multipleStatements: true,
  });
  return pool;
}

async function initSchemaAndSeed() {
  const p = await initPool();
  const createTablesSQL = `
  CREATE TABLE IF NOT EXISTS companies (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type ENUM('company','hospital') NOT NULL DEFAULT 'company',
    email VARCHAR(255) NULL,
    phone VARCHAR(50) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_id INT NOT NULL,
    title VARCHAR(255) NOT NULL,
    due_date DATE NOT NULL,
    due_time TIME NOT NULL,
    frequency ENUM('once','daily','weekly','monthly','yearly') NOT NULL DEFAULT 'once',
    next_run DATETIME NOT NULL,
    status ENUM('active','inactive') NOT NULL DEFAULT 'active',
    notes TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
  );
  
  CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('user','admin','super_admin') NOT NULL DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    company_id INT NOT NULL,
    title VARCHAR(255) NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    trx_date DATE NOT NULL,
    status ENUM('pending','paid','overdue') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
  );
  
  CREATE TABLE IF NOT EXISTS app_settings (
    id INT PRIMARY KEY AUTO_INCREMENT,
    installed TINYINT(1) NOT NULL DEFAULT 0,
    license_code VARCHAR(128) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS license_keys (
    id INT PRIMARY KEY AUTO_INCREMENT,
    code VARCHAR(128) NOT NULL UNIQUE,
    status ENUM('unused','active','revoked') NOT NULL DEFAULT 'unused',
    note VARCHAR(255) NULL,
    used_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  `;

  await p.query(createTablesSQL);

  const [col] = await p.query("SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='role'");
  if (col[0].cnt === 0) {
    await p.query("ALTER TABLE users ADD COLUMN role ENUM('user','admin','super_admin') NOT NULL DEFAULT 'user'");
  }

  // Ensure single settings row exists
  const [srows] = await p.query('SELECT COUNT(*) AS cnt FROM app_settings');
  if (srows[0].cnt === 0) {
    await p.query('INSERT INTO app_settings (installed) VALUES (0)');
  }

  const [rows] = await p.query('SELECT COUNT(*) AS cnt FROM companies');
  if (rows[0].cnt === 0) {
    const seedSQL = `
      INSERT INTO companies (name, type, email, phone) VALUES
      ('PT Maju Jaya', 'company', 'finance@majujaya.co.id', '021-1234567'),
      ('RS Sehat Sentosa', 'hospital', 'billing@rssehat.id', '021-7654321'),
      ('CV Andalan', 'company', 'admin@andalan.id', '0812-345-678');

      INSERT INTO reminders (company_id, title, due_date, due_time, frequency, next_run, status, notes) VALUES
      (1, 'Tagihan Listrik', DATE_ADD(CURDATE(), INTERVAL 2 DAY), '09:00:00', 'monthly', CONCAT(DATE_ADD(CURDATE(), INTERVAL 2 DAY), ' 09:00:00'), 'active', 'Pembayaran PLN bulanan'),
      (1, 'Langganan Internet', DATE_ADD(CURDATE(), INTERVAL 1 DAY), '10:30:00', 'monthly', CONCAT(DATE_ADD(CURDATE(), INTERVAL 1 DAY), ' 10:30:00'), 'active', 'ISP fiber'),
      (2, 'Perpanjang Lisensi Radiologi', DATE_ADD(CURDATE(), INTERVAL 0 DAY), '14:00:00', 'yearly', CONCAT(CURDATE(), ' 14:00:00'), 'active', 'Dokumen lisensi'),
      (2, 'Tagihan Oksigen Medis', DATE_ADD(CURDATE(), INTERVAL 0 DAY), '08:00:00', 'weekly', CONCAT(CURDATE(), ' 08:00:00'), 'active', 'Vendor oksigen'),
      (3, 'Tagihan Air', DATE_ADD(CURDATE(), INTERVAL 3 DAY), '11:15:00', 'monthly', CONCAT(DATE_ADD(CURDATE(), INTERVAL 3 DAY), ' 11:15:00'), 'active', 'PDAM'),
      (3, 'Reminder Harian Kebersihan', CURDATE(), '07:45:00', 'daily', CONCAT(CURDATE(), ' 07:45:00'), 'active', 'Checklist kebersihan harian');
    `;
    await p.query(seedSQL);
  }

  const [urows] = await p.query('SELECT COUNT(*) AS cnt FROM users');
  if (urows[0].cnt === 0) {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('admin123', 10);
    await p.query("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'super_admin')", ['admin', hash]);
  }

  const bcrypt2 = require('bcryptjs');
  const [su] = await p.query('SELECT * FROM users WHERE username = ?', ['superadmin']);
  if (su.length === 0) {
    const sh = await bcrypt2.hash('super123', 10);
    await p.query("INSERT INTO users (username, password_hash, role) VALUES ('superadmin', ?, 'super_admin')", [sh]);
  }
  const [au] = await p.query('SELECT * FROM users WHERE username = ?', ['adminuser']);
  if (au.length === 0) {
    const ah = await bcrypt2.hash('admin1234', 10);
    await p.query("INSERT INTO users (username, password_hash, role) VALUES ('adminuser', ?, 'admin')", [ah]);
  }
}

module.exports = {
  initPool,
  initSchemaAndSeed,
};