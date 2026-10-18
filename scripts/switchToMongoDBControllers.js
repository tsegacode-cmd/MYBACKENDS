import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Switch routes to use MongoDB-only controllers
 */

const routeFiles = [
  {
    file: '../routes/userRoutes.js',
    oldImport: "import * as userController from '../controllers/userController.js';",
    newImport: "import * as userController from '../controllers/userController.mongodb.js';"
  },
  {
    file: '../routes/dataRegistrationRoutes.js',
    oldImport: "import * as dataRegistrationController from '../controllers/dataRegistrationController.js';",
    newImport: "import * as dataRegistrationController from '../controllers/dataRegistrationController.mongodb.js';"
  },
  {
    file: '../routes/clientRoutes.js',
    oldImport: "import * as clientController from '../controllers/clientController.js';",
    newImport: "import * as clientController from '../controllers/clientController.mongodb.js';"
  },
  {
    file: '../routes/transactionRoutes.js',
    oldImport: "import * as transactionController from '../controllers/transactionController.js';",
    newImport: "import * as transactionController from '../controllers/transactionController.mongodb.js';"
  }
];

console.log('🔄 Switching to MongoDB-only controllers...');
console.log('');

let successCount = 0;
let errorCount = 0;

for (const route of routeFiles) {
  try {
    const filePath = path.join(__dirname, route.file);
    
    if (!fs.existsSync(filePath)) {
      console.log(`⚠️  File not found: ${route.file}`);
      continue;
    }

    let content = fs.readFileSync(filePath, 'utf8');
    
    if (content.includes(route.newImport)) {
      console.log(`✅ ${route.file} - Already using MongoDB controller`);
      successCount++;
      continue;
    }

    if (!content.includes(route.oldImport)) {
      console.log(`⚠️  ${route.file} - Import pattern not found`);
      continue;
    }

    content = content.replace(route.oldImport, route.newImport);
    fs.writeFileSync(filePath, content, 'utf8');
    
    console.log(`✅ ${route.file} - Switched to MongoDB controller`);
    successCount++;
  } catch (error) {
    console.error(`❌ ${route.file} - Error: ${error.message}`);
    errorCount++;
  }
}

console.log('');
console.log('='.repeat(50));
console.log('Summary:');
console.log(`  ✅ Success: ${successCount}`);
console.log(`  ❌ Errors: ${errorCount}`);
console.log('='.repeat(50));

if (errorCount === 0) {
  console.log('');
  console.log('✅ All routes now use MongoDB-only controllers!');
  console.log('✅ Application will require MongoDB to function');
  console.log('✅ No in-memory fallback - all data persists');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Ensure MongoDB is running');
  console.log('  2. Run: npm run check-mongodb');
  console.log('  3. Start server: npm start');
} else {
  console.log('');
  console.log('⚠️  Some routes could not be updated');
  console.log('Please check the errors above and update manually');
}
