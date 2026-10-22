import bcrypt from 'bcryptjs';
import { runNeonMaintenance } from './utils/neonMaintenance.js';

const password = process.env.NEW_USER_PASSWORD;
if (process.env.CONFIRM_ALL_USER_PASSWORD_RESET !== 'true' || !password || password.length < 12) {
  console.error(
    'Password reset not started. Set NEW_USER_PASSWORD (at least 12 characters) and ' +
    'CONFIRM_ALL_USER_PASSWORD_RESET=true to explicitly reset all active Neon users.'
  );
  process.exitCode = 1;
} else {
  await runNeonMaintenance(async pool => {
    const passwordHash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(`
      UPDATE users
      SET password_hash = $1, updated_at = CURRENT_TIMESTAMP::text
      WHERE is_active = 1
      RETURNING username, role
    `, [passwordHash]);
    console.log(`Updated password hashes for ${rows.length} active Neon users.`);
    for (const user of rows) console.log(`${user.username} (${user.role})`);
  });
}
