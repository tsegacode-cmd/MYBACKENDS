import { addNeonColumns, runNeonMaintenance } from './utils/neonMaintenance.js';

await runNeonMaintenance(async pool => {
  console.log('Adding commission_settings to Neon users...');
  await addNeonColumns(pool, 'users', { commission_settings: 'TEXT' });
});
