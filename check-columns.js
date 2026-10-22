import { getNeonTableColumns, runNeonMaintenance } from './utils/neonMaintenance.js';

await runNeonMaintenance(async pool => {
  const columns = await getNeonTableColumns(pool, 'data_registrations');
  console.log(`Total columns: ${columns.length}`);
  for (const [index, column] of columns.entries()) {
    console.log(`${index + 1}. ${column.column_name} (${column.data_type})`);
  }
});
