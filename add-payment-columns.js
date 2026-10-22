import { addRegistrationPaymentColumns, runNeonMaintenance } from './utils/neonMaintenance.js';

await runNeonMaintenance(async pool => {
  console.log('Adding payment columns to Neon...');
  await addRegistrationPaymentColumns(pool);
});
