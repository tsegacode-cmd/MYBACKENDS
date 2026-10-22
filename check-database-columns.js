import { runNeonMaintenance } from './utils/neonMaintenance.js';

await runNeonMaintenance(async pool => {
  console.log('Checking Neon registration columns...');
  const { rows: columns } = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'data_registrations'
     ORDER BY ordinal_position`
  );
  if (!columns.length) throw new Error('Required public.data_registrations table does not exist in Neon');
  for (const column of columns) {
    console.log(`${column.column_name} (${column.data_type}; nullable=${column.is_nullable}; default=${column.column_default ?? 'none'})`);
  }
  const names = new Set(columns.map(column => column.column_name));
  const insertable = columns.filter(column => !['_id', 'created_at', 'updated_at', 'registered_at'].includes(column.column_name));
  const managed = columns.filter(column => ['_id', 'created_at', 'updated_at', 'registered_at'].includes(column.column_name));
  console.log(`Insertable columns (${insertable.length}): ${insertable.map(column => column.column_name).join(', ')}`);
  console.log(`Managed columns: ${managed.map(column => column.column_name).join(', ')}`);
  console.log(`payment_status: ${names.has('payment_status') ? 'present' : 'missing'}`);
  console.log(`staff_username: ${names.has('staff_username') ? 'present' : 'missing'}`);
  console.log(`staff_full_name: ${names.has('staff_full_name') ? 'present' : 'missing'}`);
});
