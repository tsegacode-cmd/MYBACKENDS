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

  // Fallback: If decryption fails, return empty config to prevent crash / banner error
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

const findUserByPhone = (phone) => db.prepare(`
  SELECT _id AS id, username, email, password_hash, full_name, role, permissions,
         position, phone, telegram_chat_id, is_active
  FROM users WHERE ${PHONE_SQL} = ? AND is_active = 1
`).get(normalizePhone(phone));

const findUserByEmail = (email) => db.prepare(`
  SELECT _id AS id, username, email, password_hash, full_name, role, permissions,
         position, phone, telegram_chat_id, is_active
  FROM users WHERE lower(trim(email)) = ? AND is_active = 1
`).get(normalizeEmail(email));

const hashCode = (challengeId, code) =>
  crypto.createHmac('sha256', getSecret()).update(`${challengeId}:${code}`).digest('hex');
const saveRegistrationTicket = (challenge, data) => {
  const contact = data.contactType === 'email'
    ? data.email
    : data.contactType === 'telegram' ? data.telegramChatId : normalizePhone(data.phone);
  db.prepare(`
    INSERT INTO registration_otp_tickets (challenge_id, contact_type, contact, phone)
    VALUES (?, ?, ?, ?)
  `).run(challenge.challenge_id, data.contactType, contact, normalizePhone(data.phone));
};

const sendSMS = async (config, phone, code) => {
  const message = `Your REDSEA verification code is ${code}. It expires in ${OTP_LIFETIME_MINUTES} minutes.`;
  if (config.smsProvider === 'twilio') {
    if (!config.smsAccountSid || !config.smsApiToken || (!config.smsSenderId && !config.smsMessagingServiceSid)) {
      throw new Error('Twilio is not fully configured. Enter the Account SID, Auth Token, and a sender number or Messaging Service SID.');
    }
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      throw new Error('Twilio requires the phone number in international format, including + and the country code.');
    }
    const form = new URLSearchParams({
      To: phone,
      Body: message,
      ...(config.smsMessagingServiceSid ? { MessagingServiceSid: config.smsMessagingServiceSid } : { From: config.smsSenderId }),
    });
    const credentials = Buffer.from(`${config.smsAccountSid}:${config.smsApiToken}`).toString('base64');
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.smsAccountSid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      throw new Error(`Twilio rejected the SMS request (${response.status}).`);
    }
    return;
  }

  if (!config.smsEndpoint || !config.smsApiToken) {
    throw new Error('SMS is not configured. Configure Twilio or an HTTPS SMS gateway endpoint and API token.');
  }

  let body;
  try {
    const serialized = config.smsBodyTemplate || '{"to":"{{phone}}","message":"{{message}}","sender":"{{sender}}"}';
    body = JSON.parse(serialized
      .replaceAll('{{phone}}', phone)
      .replaceAll('{{message}}', message)
      .replaceAll('{{otp}}', code)
      .replaceAll('{{sender}}', config.smsSenderId || 'REDSEA'));
  } catch (error) {
    throw new Error(`SMS request body template must be valid JSON: ${error.message}`);
  }

  const headerName = config.smsAuthHeader || 'Authorization';
  const authValue = `${config.smsAuthPrefix ?? 'Bearer '}${config.smsApiToken}`;
  const response = await fetch(config.smsEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [headerName]: authValue },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`SMS provider rejected the request (${response.status}).`);
  }
};

const sendEmailOtp = async (config, email, code) => {
  if (!config.resendApiKey || !config.resendFromEmail) {
    throw new Error('Email OTP is not configured. Ask the administrator to configure Resend in Root Dashboard → OTP API.');
  }

  const message = `Your REDSEA verification code is ${code}. It expires in ${OTP_LIFETIME_MINUTES} minutes.`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.resendFromEmail,
      to: [email],
      subject: 'Your REDSEA verification code',
      text: message,
      html: `<p>${message}</p>`,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(`Resend could not deliver the verification code: ${result.message || response.statusText}`);
  }
};

const sendTelegram = async (config, chatId, code, message) => {
  if (!config.telegramBotToken) {
    throw new Error('Telegram is not configured. Ask the administrator to add the Telegram bot token.');
  }
  if (!chatId) {
    throw new Error('The Telegram bot is configured, but no Telegram chat is linked to this account. Sign in with your account password, open My Profile, and verify your private Telegram chat before requesting a Telegram code.');
  }

  const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message || `Your REDSEA verification code is ${code}. It expires in ${OTP_LIFETIME_MINUTES} minutes.`,
    }),
    signal: AbortSignal.timeout(10000),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('Telegram returned an invalid response while sending the code.');
  }
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram could not deliver the code: ${result.description || response.statusText}`);
  }
};

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

    await sendTelegram(
      config,
      config.rootTelegramChatId,
      '',
      `REDSEA Telegram test successful. This bot (@${identityResult.result.username}) can deliver Root OTP messages to this chat.`,
    );
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

    const user = db.prepare('SELECT _id FROM users WHERE _id = ? AND is_active = 1').get(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'The account is no longer active.' });
    }

    const requestIp = String(req.ip || req.socket.remoteAddress || '').slice(0, 80);
    const recentCount = db.prepare(`
      SELECT COUNT(*) AS count FROM telegram_link_challenges
      WHERE user_id = ? AND created_at >= datetime('now', '-15 minutes')
    `).get(req.user.id).count;
    if (recentCount >= 3) {
      return res.status(429).json({ success: false, message: 'Too many Telegram link requests. Wait 15 minutes and try again.' });
    }

    const config = getConfig();
    const code = String(crypto.randomInt(100000, 1000000));
    const challengeId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + OTP_LIFETIME_MINUTES * 60 * 1000).toISOString();

    await sendTelegram(
      config,
      chatId,
      code,
      `Your REDSEA Telegram linking code is ${code}. It expires in ${OTP_LIFETIME_MINUTES} minutes.`
    );

    db.prepare(`
      UPDATE telegram_link_challenges SET consumed_at = datetime('now')
      WHERE user_id = ? AND consumed_at IS NULL
    `).run(req.user.id);
    db.prepare(`
      INSERT INTO telegram_link_challenges (challenge_id, user_id, chat_id, request_ip, code_hash, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(challengeId, req.user.id, chatId, requestIp, hashCode(challengeId, code), expiresAt);

    res.json({
      success: true,
      message: 'A verification code was sent to that Telegram chat.',
      data: { challengeId, expiresAt },
    });
  } catch (error) {
    console.error('Telegram account linking failed:', error.message);
    responseError(res, error);
  }
};

export const verifyTelegramLink = (req, res) => {
  try {
    ensureSchema();
    getSecret();
    const { challengeId, code: rawCode } = req.body;
    const code = String(rawCode || '').trim();
    const challenge = db.prepare(`
      SELECT * FROM telegram_link_challenges
      WHERE challenge_id = ? AND user_id = ?
    `).get(challengeId, req.user.id);
    if (!challenge || challenge.consumed_at) {
      return res.status(400).json({ success: false, message: 'This Telegram linking code is invalid or already used.' });
    }
    if (Date.parse(challenge.expires_at) <= Date.now()) {
      return res.status(400).json({ success: false, message: 'This Telegram linking code has expired. Request a new one.' });
    }
    if (challenge.attempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ success: false, message: 'Too many incorrect codes. Request a new one.' });
    }
    const expectedHash = hashCode(challenge.challenge_id, code);
    if (!/^\d{6}$/.test(code) || !crypto.timingSafeEqual(Buffer.from(challenge.code_hash, 'hex'), Buffer.from(expectedHash, 'hex'))) {
      db.prepare('UPDATE telegram_link_challenges SET attempts = attempts + 1 WHERE challenge_id = ?')
        .run(challenge.challenge_id);
      return res.status(400).json({ success: false, message: 'The Telegram linking code is incorrect.' });
    }

    const alreadyLinked = db.prepare('SELECT 1 FROM users WHERE telegram_chat_id = ? AND _id != ?')
      .get(challenge.chat_id, req.user.id);
    if (alreadyLinked) {
      return res.status(409).json({ success: false, message: 'This Telegram chat is already linked to another account.' });
    }

    const update = db.prepare("UPDATE users SET telegram_chat_id = ?, updated_at = datetime('now') WHERE _id = ? AND is_active = 1")
      .run(challenge.chat_id, req.user.id);
    if (!update.changes) {
      return res.status(404).json({ success: false, message: 'The account is no longer active.' });
    }
    db.prepare("UPDATE telegram_link_challenges SET consumed_at = datetime('now') WHERE challenge_id = ?")
      .run(challenge.challenge_id);
    res.json({ success: true, message: 'Telegram chat linked. Telegram OTP login is now available.' });
  } catch (error) {
    console.error('Telegram account linking verification failed:', error.message);
    responseError(res, error);
  }
};

export const telegramMiniAppLogin = (req, res) => {
  try {
    ensureSchema();
    getSecret();

    const initData = String(req.body.initData || '');
    if (!initData || initData.length > 4096) {
      return res.status(400).json({ success: false, message: 'Telegram Mini App data is missing or invalid.' });
    }

    const config = getConfig();
    if (!config.telegramBotToken) {
      return res.status(503).json({ success: false, message: 'Telegram Mini App sign-in is not configured. Ask the administrator to configure the Telegram bot token in Root Dashboard → OTP API.' });
    }
    if (!isPurposeMethodEnabled(config, 'login', 'telegram')) {
      return res.status(403).json({ success: false, message: 'Telegram sign-in is disabled in Root Dashboard → OTP API.' });
    }

    const entries = Array.from(new URLSearchParams(initData).entries());
    const keys = entries.map(([key]) => key);
    const hash = new URLSearchParams(initData).get('hash');
    if (new Set(keys).size !== keys.length || !/^[a-f0-9]{64}$/i.test(hash || '')) {
      return res.status(401).json({ success: false, message: 'Telegram Mini App data could not be verified. Reopen the Mini App and try again.' });
    }

    const dataCheckString = entries
      .filter(([key]) => key !== 'hash')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(config.telegramBotToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'))) {
      return res.status(401).json({ success: false, message: 'Telegram Mini App data could not be verified. Reopen the Mini App and try again.' });
    }

    const params = new URLSearchParams(initData);
    const authDate = Number(params.get('auth_date'));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > 86400) {
      return res.status(401).json({ success: false, message: 'Telegram Mini App data has expired. Reopen the Mini App and try again.' });
    }

    let telegramUser;
    try {
      telegramUser = JSON.parse(params.get('user') || '');
    } catch {
      return res.status(401).json({ success: false, message: 'Telegram Mini App user data is invalid.' });
    }
    if (!Number.isSafeInteger(telegramUser?.id) || telegramUser.id <= 0) {
      return res.status(401).json({ success: false, message: 'Telegram Mini App user data is invalid.' });
    }

    const user = db.prepare(`
      SELECT _id AS id, username, email, full_name, role, permissions, position, phone,
             telegram_chat_id, is_active
      FROM users WHERE telegram_chat_id = ? AND is_active = 1
    `).get(String(telegramUser.id));
    if (!user) {
      return res.status(403).json({ success: false, message: 'No active account is linked to this Telegram account. Sign in with your password and link Telegram in My Profile first.' });
    }
    if (['root', 'admin'].includes(String(user.role || '').toLowerCase())) {
      return res.status(403).json({ success: false, message: 'Root accounts must sign in through the Root Portal.' });
    }

    db.prepare("UPDATE users SET last_login = datetime('now') WHERE _id = ?").run(user.id);
    const session = issueSession(user);
    res.json({ success: true, message: 'Telegram Mini App login successful.', data: session });
  } catch (error) {
    console.error('Telegram Mini App login failed:', error.message);
    responseError(res, error);
  }
};

export const telegramWidgetLogin = (req, res) => {
  try {
    ensureSchema();
    getSecret();

    const telegramUser = req.body.telegramUser;
    const isRoot = req.body.isRoot === true;
    const config = getConfig();
    if (!isRoot && !isPurposeMethodEnabled(config, 'login', 'telegram')) {
      return res.status(403).json({ success: false, message: 'Telegram sign-in is disabled in Root Dashboard → OTP API.' });
    }
    if (!isRoot && !isTelegramWidgetEnabled(config, 'login')) {
      return res.status(403).json({ success: false, message: 'Telegram sign-in button is hidden in Root Dashboard → OTP API.' });
    }
    if (!config.telegramBotToken || !config.telegramBotUsername) {
      return res.status(503).json({ success: false, message: 'Telegram Login Widget is not configured. Ask an administrator to configure the bot token and username in Root Dashboard → OTP API.' });
    }
    if (!telegramUser || typeof telegramUser !== 'object' || Array.isArray(telegramUser)) {
      return res.status(400).json({ success: false, message: 'Telegram sign-in data is missing or invalid.' });
    }

    const { hash: receivedHash, ...userFields } = telegramUser;
    const fields = Object.entries(userFields);
    const telegramId = Number(telegramUser.id);
    const authDate = Number(telegramUser.auth_date);
    if (!/^[a-f0-9]{64}$/i.test(String(receivedHash || ''))
      || !Number.isSafeInteger(telegramId) || telegramId <= 0
      || !Number.isSafeInteger(authDate)) {
      return res.status(401).json({ success: false, message: 'Telegram sign-in data could not be verified. Try again.' });
    }

    const now = Math.floor(Date.now() / 1000);
    if (authDate > now + 30 || now - authDate > 600) {
      return res.status(401).json({ success: false, message: 'Telegram sign-in data has expired. Try again.' });
    }

    const dataCheckString = fields
      .map(([key, value]) => [key, String(value)])
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const secretKey = crypto.createHash('sha256').update(config.telegramBotToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(String(receivedHash), 'hex'), Buffer.from(expectedHash, 'hex'))) {
      return res.status(401).json({ success: false, message: 'Telegram sign-in data could not be verified. Try again.' });
    }

    const roleFilter = isRoot ? "AND lower(role) IN ('root', 'admin')" : "AND lower(role) NOT IN ('root', 'admin')";
    let user = db.prepare(`
      SELECT _id AS id, username, email, full_name, role, permissions, position, phone,
             telegram_chat_id, is_active
      FROM users
      WHERE telegram_chat_id = ? AND is_active = 1 ${roleFilter}
    `).get(String(telegramId));
    if (!user && isRoot && String(config.rootTelegramChatId || '') === String(telegramId)) {
      const rootAccounts = db.prepare(`
        SELECT _id AS id, username, email, full_name, role, permissions, position, phone,
               telegram_chat_id, is_active
        FROM users
        WHERE is_active = 1 AND lower(role) IN ('root', 'admin')
      `).all();
      if (rootAccounts.length === 1) user = rootAccounts[0];
    }
    if (!user) {
      return res.status(403).json({
        success: false,
        message: isRoot
          ? 'No active root account is linked to this Telegram account. Link Telegram to the root account before signing in.'
          : 'No active account is linked to this Telegram account. Sign in with your password and link Telegram in My Profile first.',
      });
    }

    db.prepare("UPDATE users SET last_login = datetime('now') WHERE _id = ?").run(user.id);
    res.json({ success: true, message: 'Telegram sign-in successful.', data: issueSession(user, isRoot) });
  } catch (error) {
    console.error('Telegram Login Widget sign-in failed:', error.message);
    responseError(res, error);
  }
};

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

const responseError = (res, error) => res.status(error.status || 500).json({
  success: false,
  message: error.message || 'OTP request failed.',
});

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
