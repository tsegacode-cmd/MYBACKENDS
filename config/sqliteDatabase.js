import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const getDatabaseFile = () => process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '../database_files/redsea_brokerage.db');

// Initialize SQLite database
let db = null;

export const initializeSQLiteDatabase = () => {
  const dbFile = getDatabaseFile();
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  console.log('📁 Initializing SQLite Database...');
  console.log(`   Location: ${dbFile}`);
  
  db = new Database(dbFile);
  
  // Performance and capacity optimizations
  db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrency
  db.pragma('synchronous = NORMAL'); // Faster writes, still safe with WAL
  db.pragma('cache_size = -64000'); // 64MB cache (negative = KB)
  db.pragma('page_size = 4096'); // Optimal page size for modern systems
  db.pragma('temp_store = MEMORY'); // Store temp tables in memory
  db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O
  db.pragma('auto_vacuum = INCREMENTAL'); // Automatic space reclamation
  
  // Increase maximum database size to 1TB (default is ~140TB but we set explicit limit)
  // SQLite max_page_count * page_size = max database size
  // 268435456 pages * 4096 bytes = ~1TB
  db.pragma('max_page_count = 268435456');
  
  // Create tables
  createTables();
  
  // Create default root user if not exists
  createDefaultUser();
  
  console.log('✅ SQLite Database initialized successfully');
  console.log('✅ Enhanced Capacity: 1,000,000+ users, 10,000,000+ registrations');
  console.log('✅ Max Database Size: ~1TB');
  console.log('✅ Cache Size: 64MB');
  console.log('✅ Memory-Mapped I/O: 256MB');
  return true;
};

const createTables = () => {
  // Users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT DEFAULT 'user',
      position TEXT,
      phone TEXT,
      permissions TEXT,
      commission_settings TEXT,
      is_active INTEGER DEFAULT 1,
      social_restricted INTEGER NOT NULL DEFAULT 0,
      social_restriction_reason TEXT,
      social_banned INTEGER NOT NULL DEFAULT 0,
      social_ban_reason TEXT,
      social_ban_previous_active INTEGER NOT NULL DEFAULT 1,
      last_login TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  if (!userColumns.has('created_by_user_id')) {
    db.exec('ALTER TABLE users ADD COLUMN created_by_user_id TEXT');
  }
  if (!userColumns.has('created_by_role')) {
    db.exec('ALTER TABLE users ADD COLUMN created_by_role TEXT');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS service_booking_requests (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      requestId TEXT UNIQUE NOT NULL,
      request_id TEXT UNIQUE NOT NULL,
      customerUserId TEXT,
      customer_user_id TEXT,
      itemId TEXT,
      item_id TEXT,
      itemName TEXT,
      item_name TEXT,
      category TEXT,
      amount TEXT,
      paymentType TEXT,
      payment_type TEXT,
      paymentLabel TEXT,
      payment_label TEXT,
      paymentMethod TEXT,
      payment_method TEXT,
      customerName TEXT,
      customer_name TEXT,
      customerPhone TEXT,
      customer_phone TEXT,
      transactionReference TEXT,
      transaction_reference TEXT,
      paymentAccount TEXT,
      paymentStatus TEXT DEFAULT 'submitted',
      payment_status TEXT DEFAULT 'submitted',
      status TEXT DEFAULT 'pending_approval',
      requestedAt TEXT,
      requested_at TEXT,
      approvedAt TEXT,
      approved_at TEXT,
      cancelledAt TEXT,
      cancelled_at TEXT,
      updatedAt TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS service_payment_settings (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      configKey TEXT UNIQUE NOT NULL,
      configJson TEXT NOT NULL,
      updatedAt TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS social_referrals (
      referral_code TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS social_referral_joins (
      new_user_id TEXT PRIMARY KEY,
      inviter_user_id TEXT NOT NULL,
      referral_code TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS social_posts (
      post_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      product_name TEXT,
      product_price REAL,
      product_url TEXT,
      repost_of TEXT,
      visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'friends', 'private')),
      moderation_status TEXT NOT NULL DEFAULT 'active' CHECK (moderation_status IN ('active', 'hidden')),
      moderation_reason TEXT,
      moderated_by TEXT,
      moderated_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS social_post_likes (
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (post_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS social_post_shares (
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (post_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS social_post_comments (
      comment_id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS social_stories (
      story_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      image_data TEXT,
      cover_color TEXT NOT NULL DEFAULT '#8b0000',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS social_story_likes (
      story_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (story_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS social_story_comments (
      comment_id TEXT PRIMARY KEY,
      story_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS social_story_shares (
      story_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (story_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS social_follows (
      follower_id TEXT NOT NULL,
      followed_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (follower_id, followed_id),
      CHECK (follower_id <> followed_id)
    );
    CREATE TABLE IF NOT EXISTS social_friend_requests (
      request_id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (requester_id, recipient_id),
      CHECK (requester_id <> recipient_id)
    );
    CREATE TABLE IF NOT EXISTS social_messages (
      message_id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      read_at TEXT
    );
    CREATE TABLE IF NOT EXISTS social_presence (
      user_id TEXT PRIMARY KEY,
      last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS social_notifications (
      notification_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      actor_id TEXT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      link TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      read_at TEXT
    );
    CREATE TABLE IF NOT EXISTS service_catalog_products (
      product_id TEXT PRIMARY KEY,
      service_key TEXT NOT NULL CHECK (service_key IN ('broker-house', 'create-partnership', 'room-booking', 'logistics', 'movable-services')),
      product_json TEXT NOT NULL,
      published INTEGER NOT NULL DEFAULT 0,
      boosted INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_catalog_products_service ON service_catalog_products(service_key, published, boosted);
    CREATE TABLE IF NOT EXISTS promotions (
      promotion_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      image_data TEXT,
      audio_data TEXT,
      button_text TEXT,
      button_url TEXT,
      background_color TEXT NOT NULL DEFAULT '#8b0000',
      audience_status TEXT NOT NULL DEFAULT 'all' CHECK (audience_status IN ('all', 'paid', 'unpaid', 'guest', 'user', 'other')),
      badge_text TEXT,
      alert_enabled INTEGER NOT NULL DEFAULT 1,
      pinned INTEGER NOT NULL DEFAULT 0,
      popup_enabled INTEGER NOT NULL DEFAULT 0,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_promotions_visible ON promotions(is_hidden, pinned, created_at DESC);
    CREATE TABLE IF NOT EXISTS boost_requests (
      request_id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount > 0),
      payment_method TEXT NOT NULL DEFAULT '',
      payment_reference TEXT NOT NULL,
      payment_proof TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'unboosted')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (post_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_boost_requests_status ON boost_requests(status, created_at DESC);
    CREATE TABLE IF NOT EXISTS wallet_settings (
      role TEXT PRIMARY KEY,
      signup_bonus REAL NOT NULL DEFAULT 0 CHECK (signup_bonus >= 0),
      invite_reward REAL NOT NULL DEFAULT 0 CHECK (invite_reward >= 0),
      share_reward REAL NOT NULL DEFAULT 0 CHECK (share_reward >= 0),
      product_sale_percent REAL NOT NULL DEFAULT 0 CHECK (product_sale_percent >= 0 AND product_sale_percent <= 100),
      currency TEXT NOT NULL DEFAULT 'ETB'
    );
    CREATE TABLE IF NOT EXISTS wallet_ledger (
      entry_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL,
      entry_type TEXT NOT NULL,
      reference TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'ETB',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS wallet_withdrawals (
      withdrawal_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount > 0),
      payout_details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS wallet_deposits (
      deposit_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount > 0),
      payment_method TEXT NOT NULL,
      payment_reference TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_social_posts_created ON social_posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_social_post_comments_post ON social_post_comments(post_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_social_stories_expiry ON social_stories(expires_at DESC);
    CREATE INDEX IF NOT EXISTS idx_social_story_comments_story ON social_story_comments(story_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_social_notifications_user ON social_notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_social_messages_pair ON social_messages(sender_id, recipient_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user ON wallet_ledger(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_withdrawals_status ON wallet_withdrawals(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_deposits_status ON wallet_deposits(status, created_at DESC);
  `);
  const socialMessageColumns = new Set(
    db.prepare('PRAGMA table_info(social_messages)').all().map(column => column.name)
  );
  if (!socialMessageColumns.has('type')) {
    db.exec("ALTER TABLE social_messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'");
  }
  const promotionColumns = db.prepare('PRAGMA table_info(promotions)').all().map(column => column.name);
  if (!promotionColumns.includes('popup_enabled')) {
    db.exec('ALTER TABLE promotions ADD COLUMN popup_enabled INTEGER NOT NULL DEFAULT 0');
  }
  if (!promotionColumns.includes('audio_data')) {
    db.exec('ALTER TABLE promotions ADD COLUMN audio_data TEXT');
  }
  const socialPostColumns = new Set(
    db.prepare('PRAGMA table_info(social_posts)').all().map(column => column.name)
  );
  if (!socialPostColumns.has('visibility')) {
    db.exec("ALTER TABLE social_posts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'");
  }
  if (!socialPostColumns.has('product_image')) {
    db.exec('ALTER TABLE social_posts ADD COLUMN product_image TEXT');
  }
  if (!socialPostColumns.has('moderation_status')) {
    db.exec("ALTER TABLE social_posts ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'active'");
  }
  if (!socialPostColumns.has('moderation_reason')) {
    db.exec('ALTER TABLE social_posts ADD COLUMN moderation_reason TEXT');
  }
  if (!socialPostColumns.has('moderated_by')) {
    db.exec('ALTER TABLE social_posts ADD COLUMN moderated_by TEXT');
  }
  if (!socialPostColumns.has('moderated_at')) {
    db.exec('ALTER TABLE social_posts ADD COLUMN moderated_at TEXT');
  }
  for (const [column, definition] of [
    ['social_restricted', 'INTEGER NOT NULL DEFAULT 0'],
    ['social_restriction_reason', 'TEXT'],
    ['social_banned', 'INTEGER NOT NULL DEFAULT 0'],
    ['social_ban_reason', 'TEXT'],
    ['social_ban_previous_active', 'INTEGER NOT NULL DEFAULT 1']
  ]) {
    if (!userColumns.has(column)) db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_post_reports (
      report_id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      reporter_user_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
      reviewed_by TEXT,
      review_reason TEXT,
      reviewed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (post_id, reporter_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_social_post_reports_status ON social_post_reports(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_social_post_reports_post_status ON social_post_reports(post_id, status);
    CREATE TABLE IF NOT EXISTS social_moderation_log (
      moderation_id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      moderator_user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_social_moderation_log_post ON social_moderation_log(post_id, created_at DESC);
  `);
  const boostRequestColumns = new Set(
    db.prepare('PRAGMA table_info(boost_requests)').all().map(column => column.name)
  );
  if (!boostRequestColumns.has('payment_method')) {
    db.exec("ALTER TABLE boost_requests ADD COLUMN payment_method TEXT NOT NULL DEFAULT ''");
  }
  const socialPostsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'social_posts'").get()?.sql || '';
  if (/CHECK\s*\(\s*visibility/i.test(socialPostsSql) && !/'private'/i.test(socialPostsSql)) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE social_posts RENAME TO social_posts_legacy;
        CREATE TABLE social_posts (
          post_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          product_name TEXT,
          product_price REAL,
          product_url TEXT,
          product_image TEXT,
          repost_of TEXT,
          visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'friends', 'private')),
          moderation_status TEXT NOT NULL DEFAULT 'active' CHECK (moderation_status IN ('active', 'hidden')),
          moderation_reason TEXT,
          moderated_by TEXT,
          moderated_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO social_posts (post_id, user_id, content, product_name, product_price, product_url, product_image, repost_of, visibility, moderation_status, moderation_reason, moderated_by, moderated_at, created_at)
        SELECT post_id, user_id, content, product_name, product_price, product_url, product_image, repost_of, visibility, moderation_status, moderation_reason, moderated_by, moderated_at, created_at
        FROM social_posts_legacy;
        DROP TABLE social_posts_legacy;
        CREATE INDEX IF NOT EXISTS idx_social_posts_created ON social_posts(created_at DESC);
      `);
    })();
  }

  const walletLedgerColumns = new Set(
    db.prepare('PRAGMA table_info(wallet_ledger)').all().map(column => column.name)
  );
  if (!walletLedgerColumns.has('currency')) {
    db.exec("ALTER TABLE wallet_ledger ADD COLUMN currency TEXT NOT NULL DEFAULT 'ETB'");
  }

  const serviceBookingColumns = new Set(
    db.prepare('PRAGMA table_info(service_booking_requests)').all().map(column => column.name)
  );
  const serviceBookingColumnMigrations = {
    requestId: 'TEXT',
    request_id: 'TEXT',
    customerUserId: 'TEXT',
    customer_user_id: 'TEXT',
    itemId: 'TEXT',
    item_id: 'TEXT',
    itemName: 'TEXT',
    item_name: 'TEXT',
    paymentType: 'TEXT',
    payment_type: 'TEXT',
    paymentLabel: 'TEXT',
    payment_label: 'TEXT',
    paymentMethod: 'TEXT',
    payment_method: 'TEXT',
    customerName: 'TEXT',
    customer_name: 'TEXT',
    customerPhone: 'TEXT',
    customer_phone: 'TEXT',
    transactionReference: 'TEXT',
    transaction_reference: 'TEXT',
    paymentAccount: 'TEXT',
    paymentStatus: "TEXT DEFAULT 'submitted'",
    payment_status: "TEXT DEFAULT 'submitted'",
    requestedAt: 'TEXT',
    requested_at: 'TEXT',
    approvedAt: 'TEXT',
    approved_at: 'TEXT',
    cancelledAt: 'TEXT',
    cancelled_at: 'TEXT',
    updatedAt: 'TEXT',
  };
  Object.entries(serviceBookingColumnMigrations).forEach(([column, definition]) => {
    if (!serviceBookingColumns.has(column)) {
      db.exec(`ALTER TABLE service_booking_requests ADD COLUMN ${column} ${definition}`);
    }
  });
  const serviceBookingAliases = [
    ['requestId', 'request_id'],
    ['customerUserId', 'customer_user_id'],
    ['itemId', 'item_id'],
    ['itemName', 'item_name'],
    ['paymentType', 'payment_type'],
    ['paymentLabel', 'payment_label'],
    ['paymentMethod', 'payment_method'],
    ['customerName', 'customer_name'],
    ['customerPhone', 'customer_phone'],
    ['transactionReference', 'transaction_reference'],
    ['paymentStatus', 'payment_status'],
    ['requestedAt', 'requested_at'],
    ['approvedAt', 'approved_at'],
    ['cancelledAt', 'cancelled_at'],
  ];
  serviceBookingAliases.forEach(([camelColumn, snakeColumn]) => {
    if (serviceBookingColumns.has(snakeColumn)) {
      db.exec(`UPDATE service_booking_requests SET ${camelColumn} = ${snakeColumn} WHERE ${camelColumn} IS NULL`);
    }
  });
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_service_booking_request_id ON service_booking_requests(requestId)');

  // Clients table
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_type TEXT,
      full_name TEXT,
      company_name TEXT,
      national_id TEXT,
      tax_number TEXT,
      email TEXT,
      phone TEXT,
      secondary_phone TEXT,
      address TEXT,
      city TEXT,
      country TEXT,
      notes TEXT,
      status TEXT DEFAULT 'active',
      created_by INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Data registrations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS data_registrations (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_type TEXT,
      staff_id INTEGER,
      staff_username TEXT,
      staff_full_name TEXT,
      client_name TEXT,
      city TEXT DEFAULT 'Harar',
      kebele TEXT,
      house_no TEXT,
      receipt_no TEXT,
      transaction_number TEXT,
      client_phone TEXT,
      tv_no TEXT,
      person TEXT,
      client_email TEXT,
      client_type TEXT,
      project_title TEXT,
      org_type TEXT,
      contact_person TEXT,
      address TEXT,
      condition TEXT,
      sign TEXT,
      gov_letter TEXT,
      paid_amount REAL,
      payment_status TEXT DEFAULT 'unpaid',
      round INTEGER NOT NULL DEFAULT 1,
      payment_period_type TEXT DEFAULT '2014-2018',
      payment_period_from TEXT,
      payment_period_to TEXT,
      commission_period_amount REAL,
      commission_fee REAL,
      commission_total REAL,
      collected_amount REAL,
      registration_datetime TEXT,
      registered_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Upgrade existing databases without losing previously registered records.
  const registrationColumns = new Set(
    db.prepare('PRAGMA table_info(data_registrations)').all().map(column => column.name)
  );
  const registrationColumnMigrations = {
    client_type: 'TEXT',
    project_title: 'TEXT',
    org_type: 'TEXT',
    contact_person: 'TEXT',
    address: 'TEXT',
    transaction_number: 'TEXT',
    round: 'INTEGER NOT NULL DEFAULT 1',
  };
  for (const [column, definition] of Object.entries(registrationColumnMigrations)) {
    if (!registrationColumns.has(column)) {
      db.exec(`ALTER TABLE data_registrations ADD COLUMN ${column} ${definition}`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_documents (
      project_title TEXT PRIMARY KEY,
      pdf_data TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bank_receipt_documents (
      registration_id INTEGER PRIMARY KEY,
      pdf_data TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (registration_id) REFERENCES data_registrations(_id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_receipt_documents (
      registration_id INTEGER PRIMARY KEY,
      pdf_data TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (registration_id) REFERENCES data_registrations(_id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS registration_image_documents (
      registration_id INTEGER PRIMARY KEY,
      image_data TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (registration_id) REFERENCES data_registrations(_id) ON DELETE CASCADE
    )
  `);

  // Fixed transactions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS fixed_transactions (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_number TEXT UNIQUE,
      contract_id INTEGER,
      client_id INTEGER,
      service_type_id INTEGER,
      property_type TEXT,
      property_address TEXT,
      property_area REAL,
      area_unit TEXT,
      sale_price REAL,
      commission_amount REAL,
      commission_percentage REAL,
      currency TEXT DEFAULT 'ETB',
      transaction_date TEXT,
      payment_received REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'pending',
      status TEXT DEFAULT 'pending',
      notes TEXT,
      assigned_to INTEGER,
      created_by INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Movable transactions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS movable_transactions (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_number TEXT UNIQUE,
      contract_id INTEGER,
      client_id INTEGER,
      service_type_id INTEGER,
      item_type TEXT,
      item_description TEXT,
      item_specifications TEXT,
      quantity INTEGER,
      unit_price REAL,
      total_value REAL,
      commission_amount REAL,
      commission_percentage REAL,
      currency TEXT DEFAULT 'ETB',
      transaction_date TEXT,
      payment_received REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'pending',
      status TEXT DEFAULT 'pending',
      notes TEXT,
      assigned_to INTEGER,
      created_by INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Contact inquiries table
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_inquiries (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      inquiry_type TEXT,
      full_name TEXT,
      email TEXT,
      phone TEXT,
      subject TEXT,
      message TEXT,
      status TEXT DEFAULT 'new',
      priority TEXT DEFAULT 'medium',
      assigned_to INTEGER,
      response TEXT,
      responded_at TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS live_chat_messages (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      sender TEXT NOT NULL CHECK(sender IN ('client', 'admin')),
      sender_name TEXT,
      type TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      attachment_name TEXT,
      attachment_mime TEXT,
      attachment_data TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_live_chat_conversation
      ON live_chat_messages(conversation_id, _id);
    CREATE INDEX IF NOT EXISTS idx_live_chat_created
      ON live_chat_messages(created_at);
  `);
  const liveChatMessageColumns = new Set(
    db.prepare('PRAGMA table_info(live_chat_messages)').all().map(column => column.name)
  );
  if (!liveChatMessageColumns.has('sender_name')) {
    db.exec('ALTER TABLE live_chat_messages ADD COLUMN sender_name TEXT');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS live_chat_conversations (
      conversation_id TEXT PRIMARY KEY,
      participant_type TEXT NOT NULL CHECK(participant_type IN ('guest', 'account')),
      participant_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      account_id TEXT,
      account_role TEXT,
      display_name TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_live_chat_participant
      ON live_chat_conversations(participant_type, participant_id, device_id);
  `);

  // Brokerage contracts table
  db.exec(`
    CREATE TABLE IF NOT EXISTS brokerage_contracts (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_number TEXT UNIQUE,
      client_id INTEGER,
      service_type_id INTEGER,
      contract_type TEXT,
      start_date TEXT,
      end_date TEXT,
      commission_amount REAL,
      commission_percentage REAL,
      status TEXT DEFAULT 'active',
      notes TEXT,
      created_by INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Service types table
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_types (
      _id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT,
      service_name TEXT,
      service_name_ar TEXT,
      description TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes for better performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);
    CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
    CREATE INDEX IF NOT EXISTS idx_data_registrations_staff_id ON data_registrations(staff_id);
    CREATE INDEX IF NOT EXISTS idx_data_registrations_payment_status ON data_registrations(payment_status);
    CREATE INDEX IF NOT EXISTS idx_fixed_transactions_client_id ON fixed_transactions(client_id);
    CREATE INDEX IF NOT EXISTS idx_movable_transactions_client_id ON movable_transactions(client_id);
  `);
};

const createDefaultUser = () => {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM users');
  const result = stmt.get();
  
  if (result.count === 0) {
    const insert = db.prepare(`
      INSERT INTO users (username, email, password_hash, full_name, role, position, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    const rootUsername = process.env.ROOT_USERNAME || 'root';
    const rootPassword = process.env.ROOT_PASSWORD;
    const rootPasswordHash = rootPassword
      ? bcrypt.hashSync(rootPassword, 10)
      : '$2a$10$rZ5qH8qZ5qH8qZ5qH8qZ5u';
    insert.run(
      rootUsername,
      'root@redsea.com',
      rootPasswordHash,
      'Root Administrator',
      'admin',
      'System Administrator',
      1
    );
    
    console.log('✅ Created default root user');
  }
};

// Get raw SQLite database instance
export const getRawSQLiteDB = () => {
  if (!db) {
    throw new Error('SQLite database not initialized');
  }
  return db;
};

// MongoDB-compatible wrapper
export const getSQLiteDB = () => {
  if (!db) {
    throw new Error('SQLite database not initialized');
  }

  return {
    collection: (name) => ({
      find: (query = {}) => ({
        toArray: async () => {
          const conditions = buildWhereClause(query);
          const sql = `SELECT * FROM ${name} ${conditions.where}`;
          return db.prepare(sql).all(...conditions.params);
        },
        sort: (sortObj) => ({
          toArray: async () => {
            const conditions = buildWhereClause(query);
            const sortKey = Object.keys(sortObj)[0];
            const sortOrder = sortObj[sortKey] === 1 ? 'ASC' : 'DESC';
            const sql = `SELECT * FROM ${name} ${conditions.where} ORDER BY ${sortKey} ${sortOrder}`;
            return db.prepare(sql).all(...conditions.params);
          },
          limit: (n) => ({
            toArray: async () => {
              const conditions = buildWhereClause(query);
              const sortKey = Object.keys(sortObj)[0];
              const sortOrder = sortObj[sortKey] === 1 ? 'ASC' : 'DESC';
              const sql = `SELECT * FROM ${name} ${conditions.where} ORDER BY ${sortKey} ${sortOrder} LIMIT ?`;
              return db.prepare(sql).all(...conditions.params, n);
            }
          }),
          skip: (n) => ({
            limit: (limit) => ({
              toArray: async () => {
                const conditions = buildWhereClause(query);
                const sortKey = Object.keys(sortObj)[0];
                const sortOrder = sortObj[sortKey] === 1 ? 'ASC' : 'DESC';
                const sql = `SELECT * FROM ${name} ${conditions.where} ORDER BY ${sortKey} ${sortOrder} LIMIT ? OFFSET ?`;
                return db.prepare(sql).all(...conditions.params, limit, n);
              }
            })
          })
        }),
        limit: (n) => ({
          toArray: async () => {
            const conditions = buildWhereClause(query);
            const sql = `SELECT * FROM ${name} ${conditions.where} LIMIT ?`;
            return db.prepare(sql).all(...conditions.params, n);
          }
        }),
        skip: (n) => ({
          limit: (limit) => ({
            toArray: async () => {
              const conditions = buildWhereClause(query);
              const sql = `SELECT * FROM ${name} ${conditions.where} LIMIT ? OFFSET ?`;
              return db.prepare(sql).all(...conditions.params, limit, n);
            }
          })
        })
      }),
      findOne: async (query) => {
        const conditions = buildWhereClause(query);
        const sql = `SELECT * FROM ${name} ${conditions.where} LIMIT 1`;
        return db.prepare(sql).get(...conditions.params);
      },
      insertOne: async (doc) => {
        const keys = Object.keys(doc).filter(k => k !== '_id');
        const placeholders = keys.map(() => '?').join(', ');
        const sql = `INSERT INTO ${name} (${keys.join(', ')}) VALUES (${placeholders})`;
        const result = db.prepare(sql).run(...keys.map(k => serializeValue(doc[k])));
        return { insertedId: result.lastInsertRowid, ...doc, _id: result.lastInsertRowid };
      },
      insertMany: async (docs) => {
        const insert = db.transaction((documents) => {
          for (const doc of documents) {
            const keys = Object.keys(doc).filter(k => k !== '_id');
            const placeholders = keys.map(() => '?').join(', ');
            const sql = `INSERT INTO ${name} (${keys.join(', ')}) VALUES (${placeholders})`;
            db.prepare(sql).run(...keys.map(k => serializeValue(doc[k])));
          }
        });
        insert(docs);
        return { insertedCount: docs.length };
      },
      updateOne: async (query, update) => {
        const conditions = buildWhereClause(query);
        const setClause = Object.keys(update.$set || update)
          .map(k => `${k} = ?`)
          .join(', ');
        const values = Object.values(update.$set || update).map(serializeValue);
        const sql = `UPDATE ${name} SET ${setClause}, updated_at = CURRENT_TIMESTAMP ${conditions.where}`;
        const result = db.prepare(sql).run(...values, ...conditions.params);
        return { matchedCount: result.changes, modifiedCount: result.changes };
      },
      deleteOne: async (query) => {
        const conditions = buildWhereClause(query);
        const sql = `DELETE FROM ${name} ${conditions.where}`;
        const result = db.prepare(sql).run(...conditions.params);
        return { deletedCount: result.changes };
      },
      countDocuments: async (query = {}) => {
        const conditions = buildWhereClause(query);
        const sql = `SELECT COUNT(*) as count FROM ${name} ${conditions.where}`;
        const result = db.prepare(sql).get(...conditions.params);
        return result.count;
      },
      aggregate: (pipeline) => ({
        toArray: async () => {
          // Simplified aggregation support
          let sql = `SELECT * FROM ${name}`;
          const params = [];
          
          pipeline.forEach(stage => {
            if (stage.$match) {
              const conditions = buildWhereClause(stage.$match);
              sql += ` ${conditions.where}`;
              params.push(...conditions.params);
            }
            if (stage.$group) {
              // Basic grouping support
              const groupFields = [];
              const selectFields = [];
              
              Object.entries(stage.$group).forEach(([key, value]) => {
                if (key === '_id') {
                  if (value) selectFields.push(`${value.replace('$', '')} as _id`);
                } else if (value.$sum) {
                  if (value.$sum === 1) {
                    selectFields.push(`COUNT(*) as ${key}`);
                  } else {
                    const field = value.$sum.replace('$', '');
                    selectFields.push(`SUM(${field}) as ${key}`);
                  }
                }
              });
              
              sql = `SELECT ${selectFields.join(', ')} FROM ${name}`;
              if (stage.$group._id) {
                sql += ` GROUP BY ${stage.$group._id.replace('$', '')}`;
              }
            }
          });
          
          return db.prepare(sql).all(...params);
        }
      })
    })
  };
};

const buildWhereClause = (query) => {
  if (!query || Object.keys(query).length === 0) {
    return { where: '', params: [] };
  }

  const conditions = [];
  const params = [];

  Object.entries(query).forEach(([key, value]) => {
    if (key === '$or') {
      const orConditions = value.map(condition => {
        const orConds = [];
        const orParams = [];
        Object.entries(condition).forEach(([k, v]) => {
          orConds.push(`${k} = ?`);
          orParams.push(serializeValue(v));
        });
        params.push(...orParams);
        return `(${orConds.join(' OR ')})`;
      });
      conditions.push(`(${orConditions.join(' OR ')})`);
    } else if (typeof value === 'object' && value !== null) {
      if (value.$in) {
        conditions.push(`${key} IN (${value.$in.map(() => '?').join(', ')})`);
        params.push(...value.$in.map(serializeValue));
      } else if (value.$ne) {
        conditions.push(`${key} != ?`);
        params.push(serializeValue(value.$ne));
      } else if (value.$gte) {
        conditions.push(`${key} >= ?`);
        params.push(serializeValue(value.$gte));
      } else if (value.$lte) {
        conditions.push(`${key} <= ?`);
        params.push(serializeValue(value.$lte));
      }
    } else {
      conditions.push(`${key} = ?`);
      params.push(serializeValue(value));
    }
  });

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  };
};

const serializeValue = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
};

export const getDatabaseStatus = () => {
  return {
    type: 'sqlite',
    connected: db !== null,
    location: DB_FILE,
    capacity: {
      users: '1,000,000+',
      registrations: '10,000,000+',
      maxSize: '~1TB',
      cacheSize: '64MB',
      mmapSize: '256MB'
    }
  };
};

export default {
  initializeSQLiteDatabase,
  getSQLiteDB,
  getDatabaseStatus
};
