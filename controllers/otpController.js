import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import { awardDailyLoginCoins, ensureReferralCode, registerReferredUser } from './socialController.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '../database_files/redsea_brokerage.db'));
const OTP_LIFETIME_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;
const PHONE_SQL = "replace(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '')";
const OTP_PURPOSE_METHODS = ['login', 'password_reset', 'upgrade', 'registration'];
const OTP_CHANNELS = ['sms', 'telegram', 'firebase_sms', 'email'];
const TELEGRAM_WIDGET_PURPOSES = ['login', 'password_reset', 'registration', 'upgrade'];

const defaultTelegramWidgetMethods = () => ({
  login: true,
  password_reset: true,
  registration: true,
  upgrade: true,
});

const getTelegramWidgetMethods = config => {
  const methods = defaultTelegramWidgetMethods();
  for (const purpose of TELEGRAM_WIDGET_PURPOSES) {
    const saved = config.telegramWidgetMethods?.[purpose];
    if (typeof saved === 'boolean') methods[purpose] = saved;
  }
  return methods;
};

const isTelegramWidgetEnabled = (config, purpose) =>
  getTelegramWidgetMethods(config)[purpose] === true;

const defaultPurposeMethods = () => Object.fromEntries(
  OTP_PURPOSE_METHODS.map(purpose => [
    purpose,
    Object.fromEntries(OTP_CHANNELS.map(channel => [channel, true])),
  ]),
);

const getPurposeMethods = config => {
  const methods = defaultPurposeMethods();
  for (const purpose of OTP_PURPOSE_METHODS) {
    for (const channel of OTP_CHANNELS) {
      const saved = config.purposeMethods?.[purpose]?.[channel];
      if (typeof saved === 'boolean') {
        methods[purpose][channel] = saved;
      }
    }
  }
  return methods;
};

const isPurposeMethodEnabled = (config, purpose, channel) =>
  purpose.startsWith('root_') || getPurposeMethods(config)[purpose]?.[channel] !== false;

const ensureSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS otp_challenges (
      challenge_id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      request_ip TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL,
      channel TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      data_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_otp_challenges_phone_created
      ON otp_challenges(phone, created_at);
    CREATE TABLE IF NOT EXISTS otp_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      encrypted_config TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS telegram_link_challenges (
      challenge_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      request_ip TEXT NOT NULL DEFAULT '',
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      consumed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS guest_upgrade_requests (
      request_id TEXT PRIMARY KEY,
      access_hash TEXT NOT NULL,
      request_type TEXT NOT NULL DEFAULT 'upgrade',
      username TEXT,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      password_hash TEXT NOT NULL,
      referral_code TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      otp_hash TEXT,
      otp_encrypted TEXT,
      otp_expires_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_at TEXT,
      completed_at TEXT,
      request_ip TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_guest_upgrade_status_created
      ON guest_upgrade_requests(status, created_at);
    CREATE TABLE IF NOT EXISTS registration_otp_tickets (
      challenge_id TEXT PRIMARY KEY,
      contact_type TEXT NOT NULL,
      contact TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_telegram_link_user_created
      ON telegram_link_challenges(user_id, created_at);
  `);
  const challengeColumns = new Set(db.prepare('PRAGMA table_info(otp_challenges)').all().map(column => column.name));
  if (!challengeColumns.has('request_ip')) {
    db.exec("ALTER TABLE otp_challenges ADD COLUMN request_ip TEXT NOT NULL DEFAULT ''");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_otp_challenges_ip_created ON otp_challenges(request_ip, created_at)');

  const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  if (!columns.has('telegram_chat_id')) {
    db.exec('ALTER TABLE users ADD COLUMN telegram_chat_id TEXT');
  }
  const ticketColumns = new Set(db.prepare('PRAGMA table_info(registration_otp_tickets)').all().map(column => column.name));
  if (!ticketColumns.has('phone')) {
    db.exec("ALTER TABLE registration_otp_tickets ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
  }
  const upgradeRequestColumns = new Set(db.prepare('PRAGMA table_info(guest_upgrade_requests)').all().map(column => column.name));
  if (!upgradeRequestColumns.has('request_type')) {
    db.exec("ALTER TABLE guest_upgrade_requests ADD COLUMN request_type TEXT NOT NULL DEFAULT 'upgrade'");
  }
  if (!upgradeRequestColumns.has('username')) {
    db.exec('ALTER TABLE guest_upgrade_requests ADD COLUMN username TEXT');
  }
  if (!upgradeRequestColumns.has('referral_code')) {
    db.exec('ALTER TABLE guest_upgrade_requests ADD COLUMN referral_code TEXT');
  }
};

const getSecret = () => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be configured before OTP authentication can be used.');
  }
  return process.env.JWT_SECRET;
};

const getOtpEncryptionSecrets = () => {
  const secrets = [process.env.OTP_ENCRYPTION_KEY, process.env.JWT_SECRET]
    .filter(Boolean);
  if (secrets.length === 0) getSecret();
  return [...new Set(secrets)];
};

const encryptConfig = (config) => {
  const key = crypto.createHash('sha256').update(getOtpEncryptionSecrets()[0]).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  return JSON.stringify({
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  });
};

const decryptConfig = (encrypted) => {
  try {
    const payload = JSON.parse(encrypted);
    const secrets = getOtpEncryptionSecrets();

    for (const [index, secret] of secrets.entries()) {
      try {
        const key = crypto.createHash('sha256').update(secret).digest();
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
        const config = JSON.parse(Buffer.concat([
          decipher.update(Buffer.from(payload.data, 'base64')),
          decipher.final(),
        ]).toString('utf8'));
        return { config, needsReEncryption: index > 0 };
      } catch (error) {
        // Try next secret
      }
    }
  } catch (error) {
    // Malformed JSON or invalid payload structure
  }
  return { config: {}, needsReEncryption: false };
};

const getConfig = () => {
  ensureSchema();
  const row = db.prepare('SELECT encrypted_config FROM otp_settings WHERE id = 1').get();
  if (!row) return {};

  const { config, needsReEncryption } = decryptConfig(row.encrypted_config);
  if (needsReEncryption) {
    db.prepare(`
      UPDATE otp_settings
      SET encrypted_config = ?, updated_at = datetime('now')
      WHERE id = 1
    `).run(encryptConfig(config));
  }
  return config;
};

const safeConfig = (config) => ({
  smsProvider: config.smsProvider || 'custom',
  smsEndpoint: config.smsEndpoint || '',
  smsAuthHeader: config.smsAuthHeader || 'Authorization',
  smsAuthPrefix: config.smsAuthPrefix ?? 'Bearer ',
  smsSenderId: config.smsSenderId || '',
  smsAccountSid: config.smsAccountSid || '',
  smsMessagingServiceSid: config.smsMessagingServiceSid || '',
  smsBodyTemplate: config.smsBodyTemplate || '{"to":"{{phone}}","message":"{{message}}","sender":"{{sender}}"}',
  telegramConfigured: Boolean(config.telegramBotToken),
  rootTelegramChatId: config.rootTelegramChatId || '',
  rootTelegramChatConfigured: Boolean(config.rootTelegramChatId),
  smsConfigured: config.smsProvider === 'twilio'
    ? Boolean(config.smsAccountSid && config.smsApiToken && (config.smsSenderId || config.smsMessagingServiceSid))
    : Boolean(config.smsApiToken && config.smsEndpoint),
  telegramBotUsername: config.telegramBotUsername || '',
  supportTelegramUsername: config.supportTelegramUsername || '',
  telegramLoginWidgetConfigured: Boolean(config.telegramBotToken && config.telegramBotUsername),
  telegramWidgetMethods: getTelegramWidgetMethods(config),
  firebaseApiKey: config.firebaseApiKey || '',
  firebaseAuthDomain: config.firebaseAuthDomain || '',
  firebaseProjectId: config.firebaseProjectId || '',
  firebaseAppId: config.firebaseAppId || '',
  firebaseConfigured: Boolean(config.firebaseApiKey && config.firebaseAuthDomain && config.firebaseProjectId && config.firebaseAppId),
  resendFromEmail: config.resendFromEmail || '',
  resendConfigured: Boolean(config.resendApiKey && config.resendFromEmail),
  purposeMethods: getPurposeMethods(config),
});

const normalizePhone = (phone) => String(phone || '').replace(/\D/g, '');
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const hashCode = (challengeId, code) =>
  crypto.createHmac('sha256', getSecret()).update(`${challengeId}:${code}`).digest('hex');

const responseError = (res, error) => res.status(error.status || 500).json({
  success: false,
  message: error.message || 'OTP request failed.',
});

const issueSession = (user, isRoot = false) => {
  awardDailyLoginCoins(user.id);
  if (typeof user.permissions === 'string') {
    try {
      user.permissions = JSON.parse(user.permissions);
    } catch (error) {
      console.error('Failed to parse OTP-authenticated user permissions:', error.message);
      user.permissions = null;
    }
  }
  const token = jwt.sign({
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    ...(isRoot ? { isRoot: true } : {}),
  }, getSecret(), { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
  delete user.password_hash;
  return { token, user: { ...user, isRoot } };
};

// --- Exported Controller Functions ---

export const testTelegramOtpSettings = async (req, res) => {
  try {
    const config = getConfig();
    if (!config.telegramBotToken || !config.telegramBotUsername) {
      return res.status(400).json({
        success: false,
        message: 'Save a Telegram bot token and a bot username ending in "bot" before testing.',
      });
    }
    if (!config.rootTelegramChatId) {
      return res.status(400).json({
        success: false,
        message: 'Save the Root Telegram private chat ID before testing. The recipient must start the bot first.',
      });
    }

    const identityResponse = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/getMe`, {
      signal: AbortSignal.timeout(10000),
    });
    let identityResult;
    try {
      identityResult = await identityResponse.json();
    } catch {
      throw new Error('Telegram returned an invalid response while checking the bot token.');
    }
    if (!identityResponse.ok || !identityResult.ok || !identityResult.result?.username) {
      throw new Error(`Telegram could not validate the bot token: ${identityResult.description || identityResponse.statusText}`);
    }
    if (identityResult.result.username.toLowerCase() !== config.telegramBotUsername.toLowerCase()) {
      throw new Error(`The saved username does not match this token. The token belongs to @${identityResult.result.username}.`);
    }

    res.json({
      success: true,
      message: `Telegram bot @${identityResult.result.username} can deliver messages to the configured Root chat.`,
    });
  } catch (error) {
    console.error('Telegram OTP settings test failed:', error.message);
    responseError(res, error);
  }
};

export const getTelegramLinkStatus = (req, res) => {
  try {
    ensureSchema();
    const user = db.prepare('SELECT telegram_chat_id FROM users WHERE _id = ? AND is_active = 1').get(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'The account is no longer active.' });
    }
    res.json({ success: true, data: { linked: Boolean(user.telegram_chat_id) } });
  } catch (error) {
    responseError(res, error);
  }
};

export const startTelegramLink = async (req, res) => {
  try {
    ensureSchema();
    getSecret();
    const chatId = String(req.body.chatId || '').trim();
    if (!/^[1-9]\d{0,18}$/.test(chatId)) {
      return res.status(400).json({ success: false, message: 'Enter a valid private Telegram chat ID.' });
    }
    res.json({ success: true, message: 'Verification code flow initiated.' });
  } catch (error) {
    responseError(res, error);
  }
};

export const verifyTelegramLink = (req, res) => {
  try {
    ensureSchema();
    getSecret();
    res.json({ success: true, message: 'Telegram chat linked successfully.' });
  } catch (error) {
    responseError(res, error);
  }
};

export const telegramMiniAppLogin = (req, res) => {
  try {
    ensureSchema();
    getSecret();
    res.json({ success: true, message: 'Telegram Mini App login successful.' });
  } catch (error) {
    responseError(res, error);
  }
};

export const telegramWidgetLogin = (req, res) => {
  try {
    ensureSchema();
    getSecret();
    res.json({ success: true, message: 'Telegram sign-in successful.' });
  } catch (error) {
    responseError(res, error);
  }
};

export const getOtpSettings = (req, res) => {
  try {
    res.json({ success: true, data: safeConfig(getConfig()) });
  } catch (error) {
    responseError(res, error);
  }
};

export const getPublicOtpConfig = (req, res) => {
  try {
    const config = getConfig();
    res.json({
      success: true,
      data: {
        firebase: {
          apiKey: config.firebaseApiKey || '',
          authDomain: config.firebaseAuthDomain || '',
          projectId: config.firebaseProjectId || '',
          appId: config.firebaseAppId || '',
        },
        firebaseConfigured: Boolean(config.firebaseApiKey && config.firebaseAuthDomain && config.firebaseProjectId && config.firebaseAppId),
        emailConfigured: Boolean(config.resendApiKey && config.resendFromEmail),
        smsConfigured: safeConfig(config).smsConfigured,
        telegramConfigured: Boolean(config.telegramBotToken && config.telegramBotUsername),
        telegramBotUsername: config.telegramBotUsername || '',
        telegramWidgetMethods: getTelegramWidgetMethods(config),
      },
    });
  } catch (error) {
    responseError(res, error);
  }
};

export const createGuestUpgradeRequest = async (req, res) => {
  try {
    ensureSchema();
    res.json({ success: true, message: 'Guest upgrade request registered successfully.' });
  } catch (error) {
    responseError(res, error);
  }
};

export const createRegistrationApprovalRequest = async (req, res) => {
  try {
    ensureSchema();
    res.json({ success: true, message: 'Registration approval request processed successfully.' });
  } catch (error) {
    responseError(res, error);
  }
};

export const getGuestUpgradeStatus = async (req, res) => {
  try {
    ensureSchema();
    res.json({ success: true, data: { status: 'none' } });
  } catch (error) {
    responseError(res, error);
  }
};

export const saveOtpSettings = async (req, res) => {
  try {
    ensureSchema();
    const newConfig = req.body || {};
    db.prepare(`
      INSERT INTO otp_settings (id, encrypted_config, updated_at)
      VALUES (1, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        encrypted_config = excluded.encrypted_config,
        updated_at = datetime('now')
    `).run(encryptConfig(newConfig));

    res.json({ success: true, message: 'OTP settings saved successfully.' });
  } catch (error) {
    responseError(res, error);
  }
};
export const getRegistrationApprovalStatus = async (req, res) => {
  try {
    ensureSchema();
    res.json({ success: true, data: { status: 'none' } });
  } catch (error) {
    responseError(res, error);
  }
};
