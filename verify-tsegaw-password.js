import bcrypt from 'bcryptjs';
import { runNeonMaintenance } from './utils/neonMaintenance.js';

const username = process.env.VERIFY_USERNAME?.trim() || 'TSEGAW';
const password = process.env.VERIFY_PASSWORD;

if (!password) {
  console.error('Set VERIFY_PASSWORD in the environment to check a password. This tool does not change passwords.');
  process.exitCode = 1;
} else {
  await runNeonMaintenance(async pool => {
    const { rows: [user] } = await pool.query(
      'SELECT username, password_hash FROM users WHERE username = $1',
      [username]
    );
    if (!user) throw new Error(`User ${username} was not found in Neon`);
    if (!user.password_hash) throw new Error(`User ${username} has no password hash`);
    const valid = await bcrypt.compare(password, user.password_hash);
    console.log(`Password ${valid ? 'matches' : 'does not match'} for ${username}.`);
  });
}
