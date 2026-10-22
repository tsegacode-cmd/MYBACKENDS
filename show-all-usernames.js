import { runNeonMaintenance } from './utils/neonMaintenance.js';

await runNeonMaintenance(async pool => {
  const { rows: users } = await pool.query(`
    SELECT _id, username, role, is_active
    FROM users
    ORDER BY _id
  `);
  console.log(`Total users: ${users.length}`);
  console.table(users.map(user => ({
    id: user._id,
    username: user.username,
    role: user.role,
    active: Boolean(user.is_active)
  })));
});
