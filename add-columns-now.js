import { addRegistrationPaymentColumns, runNeonMaintenance } from './utils/neonMaintenance.js';

await runNeonMaintenance(async pool => {
  console.log('Adding registration payment columns to Neon...');
  await addRegistrationPaymentColumns(pool);
});
