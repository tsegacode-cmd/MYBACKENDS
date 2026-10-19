import { getRawSQLiteDB } from './config/databaseManager.js';

console.log('🔍 CHECKING SQLITE DATABASE COLUMNS...');
console.log('=====================================');

try {
  const db = getRawSQLiteDB();
  
  if (!db) {
    console.error('❌ Database not available');
    process.exit(1);
  }

  // Get table info
  const tableInfo = db.prepare('PRAGMA table_info(data_registrations)').all();
  
  console.log('📊 TOTAL COLUMNS:', tableInfo.length);
  console.log('');
  
  console.log('📋 COLUMN DETAILS:');
  console.log('==================');
  
  tableInfo.forEach((col, index) => {
    console.log(`${index + 1}. ${col.name} (${col.type}) ${col.notnull ? 'NOT NULL' : 'NULL'} ${col.dflt_value ? `DEFAULT ${col.dflt_value}` : ''}`);
  });
  
  console.log('');
  console.log('📝 COLUMN NAMES ONLY:');
  console.log('=====================');
  const columnNames = tableInfo.map(col => col.name);
  console.log(columnNames.join(', '));
  
  console.log('');
  console.log('🔢 COLUMNS FOR INSERT (excluding auto fields):');
  console.log('===============================================');
  const insertableColumns = tableInfo.filter(col => 
    col.name !== '_id' && 
    col.name !== 'created_at' && 
    col.name !== 'updated_at' &&
    col.name !== 'registered_at'
  );
  
  console.log('Count:', insertableColumns.length);
  console.log('Names:', insertableColumns.map(col => col.name).join(', '));
  
  console.log('');
  console.log('⚠️  AUTO-MANAGED COLUMNS (should NOT be inserted):');
  console.log('==================================================');
  const autoColumns = tableInfo.filter(col => 
    col.name === '_id' || 
    col.name === 'created_at' || 
    col.name === 'updated_at' ||
    col.name === 'registered_at'
  );
  
  autoColumns.forEach(col => {
    console.log(`- ${col.name} (${col.type}) ${col.dflt_value ? `DEFAULT ${col.dflt_value}` : ''}`);
  });
  
  console.log('');
  console.log('✅ ANALYSIS COMPLETE');
  console.log('Expected INSERT field count:', insertableColumns.length);
  
} catch (error) {
  console.error('❌ Database check failed:', error);
}