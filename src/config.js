const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {
      mysql_host: process.env.MYSQL_HOST || '127.0.0.1',
      mysql_user: process.env.MYSQL_USER || 'root',
      mysql_password: process.env.MYSQL_PASSWORD || 'asdfQWER789',
      mysql_db: process.env.MYSQL_DB || 'checkbilldb2',
      installed: true,
      license_code: 'CB-TRIAL-2025-001',
      admin_username: 'admin',
    };
  }
}

function saveConfig(cfg) {
  const out = JSON.stringify(cfg, null, 2);
  fs.writeFileSync(CONFIG_PATH, out, 'utf8');
}

module.exports = { loadConfig, saveConfig };