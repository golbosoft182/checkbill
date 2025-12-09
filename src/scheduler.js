const { addDays, addWeeks, addMonths, addYears } = require('date-fns');

function computeNextRun(current, frequency) {
  const d = new Date(current);
  switch (frequency) {
    case 'daily':
      return addDays(d, 1);
    case 'weekly':
      return addWeeks(d, 1);
    case 'monthly':
      return addMonths(d, 1);
    case 'yearly':
      return addYears(d, 1);
    case 'once':
    default:
      return null;
  }
}

async function startScheduler(pool) {
  const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
  async function tick() {
    const now = new Date();
    const [due] = await pool.query(
      `SELECT * FROM reminders WHERE status='active' AND next_run <= ?`,
      [now]
    );
    for (const r of due) {
      const next = computeNextRun(r.next_run, r.frequency);
      if (next) {
        await pool.query('UPDATE reminders SET next_run = ? WHERE id = ?', [next, r.id]);
      } else {
        await pool.query("UPDATE reminders SET status='inactive' WHERE id = ?", [r.id]);
      }
    }
  }
  await tick();
  setInterval(tick, CHECK_INTERVAL_MS);
}

module.exports = { startScheduler };