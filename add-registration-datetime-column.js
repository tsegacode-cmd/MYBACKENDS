import { addNeonColumns, runNeonMaintenance } from './utils/neonMaintenance.js';

await runNeonMaintenance(async pool => {
  console.log('Adding registration_datetime to Neon data_registrations...');
  await addNeonColumns(pool, 'data_registrations', { registration_datetime: 'TEXT' });
});
