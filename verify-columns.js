import { getNeonTableColumns, runNeonMaintenance } from './utils/neonMaintenance.js';

const requiredColumns = [
  'city',
  'receipt_no',
  'payment_period_type',
  'payment_period_from',
  'payment_period_to',
  'commission_period_amount',
  'commission_fee',
  'commission_total',
  'collected_amount',
  'registration_datetime'
];

await runNeonMaintenance(async pool => {
  const columns = await getNeonTableColumns(pool, 'data_registrations');
  const existing = new Set(columns.map(column => column.column_name));
  for (const column of columns) console.log(`${column.column_name} (${column.data_type})`);

  const missing = requiredColumns.filter(column => !existing.has(column));
  if (missing.length) {
    throw new Error(`Missing required Neon data_registrations columns: ${missing.join(', ')}`);
  }
  console.log('All required registration columns exist in Neon.');
});
