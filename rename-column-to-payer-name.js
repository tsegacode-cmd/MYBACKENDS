import { getNeonTableColumns, runNeonMaintenance } from './utils/neonMaintenance.js';

await runNeonMaintenance(async pool => {
  const columns = await getNeonTableColumns(pool, 'data_registrations');
  const names = new Set(columns.map(column => column.column_name));

  if (names.has('client_name')) {
    console.log('No rename performed: the active Neon application schema uses client_name.');
    return;
  }
  if (names.has('payer_name')) {
    throw new Error('Neon has payer_name but not client_name; active registration code expects client_name.');
  }
  throw new Error('Neither client_name nor payer_name exists in public.data_registrations.');
});
