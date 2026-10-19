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
    CREATE TABLE IF NOT EXISTS telegram_registration_contacts (
      telegram_user_id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  const payload = JSON.parse(encrypted);
  const secrets = getOtpEncryptionSecrets();
  let lastError;

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
      lastError = error;
    }
  }

  throw new Error(
    'Saved OTP settings could not be decrypted. Restore the JWT_SECRET or OTP_ENCRYPTION_KEY that was active when they were saved.',
    { cause: lastError },
  );
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
  telegramWebhookConfigured: Boolean(config.telegramWebhookRegistered && config.telegramWebhookUrl && config.telegramWebhookSecret),
  telegramWebhookUrl: config.telegramWebhookUrl || '',
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

export const resetPasswordWithTelegramMiniApp = async (req, res) => {
  try {
    ensureSchema();
    const initData = String(req.body?.initData || '');
    const newPassword = req.body?.newPassword;
    if (!initData || initData.length > 4096 || typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 128) {
      return res.status(400).json({ success: false, message: 'Open the Telegram Mini App and enter a password of at least 6 characters.' });
    }
    const config = getConfig();
    if (!config.telegramBotToken || !isPurposeMethodEnabled(config, 'password_reset', 'telegram')) {
      return res.status(403).json({ success: false, message: 'Telegram password reset is disabled or not configured in Root Dashboard → OTP API.' });
    }
    const params = new URLSearchParams(initData);
    const entries = Array.from(params.entries());
    const hash = params.get('hash');
    if (new Set(entries.map(([key]) => key)).size !== entries.length || !/^[a-f0-9]{64}$/i.test(hash || '')) {
      return res.status(401).json({ success: false, message: 'Telegram Mini App data could not be verified. Reopen it and try again.' });
    }
    const dataCheckString = entries.filter(([key]) => key !== 'hash')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(config.telegramBotToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'))) {
      return res.status(401).json({ success: false, message: 'Telegram Mini App data could not be verified. Reopen it and try again.' });
    }
    const authDate = Number(params.get('auth_date'));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > 600) {
      return res.status(401).json({ success: false, message: 'Telegram sign-in has expired. Reopen the Mini App and try again.' });
    }
    let telegramUser;
    try {
      telegramUser = JSON.parse(params.get('user') || '');
    } catch {
      return res.status(401).json({ success: false, message: 'Telegram user data is invalid.' });
    }
    if (!Number.isSafeInteger(telegramUser?.id) || telegramUser.id <= 0) {
      return res.status(401).json({ success: false, message: 'Telegram user data is invalid.' });
    }
    const user = db.prepare(`
      SELECT _id, role FROM users
      WHERE telegram_chat_id = ? AND is_active = 1 AND lower(role) NOT IN ('root', 'admin')
    `).get(String(telegramUser.id));
    if (!user) return res.status(404).json({ success: false, message: 'No active account is linked to this Telegram account.' });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const result = db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE _id = ? AND is_active = 1")
      .run(passwordHash, user._id);
    if (!result.changes) return res.status(404).json({ success: false, message: 'Account not found. Try again.' });
    res.json({ success: true, message: 'Password reset successfully. Sign in with your new password.' });
  } catch (error) {
    console.error('Telegram Mini App password reset failed:', error.message);
    responseError(res, error);
  }
};

export const prepareTelegramMiniAppRegistration = (req, res) => {
  try {
    ensureSchema();
    getSecret();
    const initData = String(req.body?.initData || '');
    const phone = String(req.body?.phone || '').trim();
    const normalizedPhone = normalizePhone(phone);
    if (!initData || initData.length > 4096) {
      return res.status(400).json({ success: false, message: 'Open signup from the Telegram Mini App and try again.' });
    }
    if (phone && (!/^[+\d\s()-]{7,24}$/.test(phone) || !/^\d{7,15}$/.test(normalizedPhone))) {
      return res.status(400).json({ success: false, message: 'Enter a valid phone number.' });
    }

    const config = getConfig();
    if (!config.telegramBotToken || !isPurposeMethodEnabled(config, 'registration', 'telegram')) {
      return res.status(403).json({ success: false, message: 'Telegram Mini App signup is not enabled in Root Dashboard → OTP API.' });
    }
    if (phone && !safeConfig(config).telegramWebhookConfigured) {
      return res.status(503).json({ success: false, message: 'Telegram phone sharing is not configured. Ask an administrator to configure the Telegram webhook in Root Dashboard → OTP API.' });
    }
    const params = new URLSearchParams(initData);
    const entries = Array.from(params.entries());
    const hash = params.get('hash');
    if (new Set(entries.map(([key]) => key)).size !== entries.length || !/^[a-f0-9]{64}$/i.test(hash || '')) {
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
    const authDate = Number(params.get('auth_date'));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > 600) {
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
    if (db.prepare('SELECT 1 FROM users WHERE telegram_chat_id = ?').get(String(telegramUser.id))) {
      return res.status(409).json({ success: false, message: 'This Telegram account is already registered. Sign in instead.' });
    }

    const challengeId = phone ? crypto.randomUUID() : null;
    if (challengeId) {
      const recentTicketCount = db.prepare(`
        SELECT COUNT(*) AS count FROM registration_otp_tickets
        WHERE contact_type = 'telegram' AND contact = ?
          AND created_at >= datetime('now', '-10 minutes')
      `).get(String(telegramUser.id)).count;
      if (recentTicketCount >= 5) {
        return res.status(429).json({ success: false, message: 'Too many signup attempts. Wait a few minutes and try again.' });
      }
      db.prepare(`
        INSERT INTO registration_otp_tickets (challenge_id, contact_type, contact, phone)
        VALUES (?, 'telegram', ?, ?)
      `).run(challengeId, String(telegramUser.id), normalizedPhone);
    }
    const suggestedName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ').slice(0, 120);
    res.json({
      success: true,
      message: 'Telegram identity verified.',
      data: {
        registrationChallengeId: challengeId,
        username: /^[A-Za-z0-9_.-]{3,40}$/.test(String(telegramUser.username || ''))
          ? String(telegramUser.username).slice(0, 40)
          : `tg${telegramUser.id}`,
        fullName: suggestedName,
        telegramChatId: String(telegramUser.id),
      },
    });
  } catch (error) {
    console.error('Telegram Mini App signup verification failed:', error.message);
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

export const configureTelegramContactWebhook = async (req, res) => {
  try {
    const config = getConfig();
    if (!config.telegramBotToken) {
      return res.status(400).json({ success: false, message: 'Configure the Telegram bot token before setting up phone sharing.' });
    }
    if (!/^https:\/\/[^\s]+$/i.test(String(config.telegramWebhookUrl || ''))) {
      return res.status(400).json({ success: false, message: 'Enter the public HTTPS URL for the Telegram contact webhook, ending in /auth/telegram/webhook.' });
    }
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(String(config.telegramWebhookSecret || ''))) {
      return res.status(400).json({ success: false, message: 'Set a webhook secret containing 1–256 letters, numbers, underscores, or hyphens.' });
    }
    const response = await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: config.telegramWebhookUrl,
        secret_token: config.telegramWebhookSecret,
        allowed_updates: ['message'],
      }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      return res.status(502).json({ success: false, message: result.description || 'Telegram could not register the phone-sharing webhook.' });
    }
    config.telegramWebhookRegistered = true;
    db.prepare(`
      INSERT INTO otp_settings (id, encrypted_config, updated_at)
      VALUES (1, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET encrypted_config = excluded.encrypted_config, updated_at = excluded.updated_at
    `).run(encryptConfig(config));
    res.json({ success: true, message: 'Telegram phone-sharing webhook configured.' });
  } catch (error) {
    console.error('Telegram contact webhook setup failed:', error.message);
    responseError(res, error);
  }
};

export const receiveTelegramContactWebhook = (req, res) => {
  try {
    const config = getConfig();
    const suppliedSecret = String(req.get('x-telegram-bot-api-secret-token') || '');
    const expectedSecret = String(config.telegramWebhookSecret || '');
    if (!expectedSecret || suppliedSecret.length !== expectedSecret.length ||
      !crypto.timingSafeEqual(Buffer.from(suppliedSecret), Buffer.from(expectedSecret))) {
      return res.status(401).json({ success: false, message: 'Telegram webhook authentication failed.' });
    }
    const message = req.body?.message;
    const senderId = Number(message?.from?.id);
    const contact = message?.contact;
    if (!Number.isSafeInteger(senderId) || senderId <= 0 || Number(contact?.user_id) !== senderId) {
      return res.json({ success: true });
    }
    const phone = String(contact.phone_number || '').trim();
    if (!/^[+\d\s()-]{7,24}$/.test(phone) || !/^\d{7,15}$/.test(normalizePhone(phone))) {
      return res.json({ success: true });
    }
    db.prepare(`
      INSERT INTO telegram_registration_contacts (telegram_user_id, phone, expires_at)
      VALUES (?, ?, datetime('now', '+10 minutes'))
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        phone = excluded.phone,
        expires_at = excluded.expires_at,
        created_at = datetime('now')
    `).run(String(senderId), phone);
    res.json({ success: true });
  } catch (error) {
    console.error('Telegram contact webhook failed:', error.message);
    responseError(res, error);
  }
};

export const getTelegramRegistrationPhone = (req, res) => {
  try {
    ensureSchema();
    const initData = String(req.body?.initData || '');
    if (!initData || initData.length > 4096) {
      return res.status(400).json({ success: false, message: 'Telegram Mini App data is missing or invalid.' });
    }
    const config = getConfig();
    if (!config.telegramBotToken || !isPurposeMethodEnabled(config, 'registration', 'telegram')) {
      return res.status(403).json({ success: false, message: 'Telegram Mini App signup is disabled in OTP settings.' });
    }
    if (!safeConfig(config).telegramWebhookConfigured) {
      return res.status(503).json({ success: false, message: 'Telegram phone sharing is not configured. Ask an administrator to configure the Telegram webhook in Root Dashboard → OTP API.' });
    }
    const params = new URLSearchParams(initData);
    const entries = Array.from(params.entries());
    const hash = params.get('hash');
    if (new Set(entries.map(([key]) => key)).size !== entries.length || !/^[a-f0-9]{64}$/i.test(hash || '')) {
      return res.status(401).json({ success: false, message: 'Telegram Mini App data could not be verified.' });
    }
    const checkString = entries.filter(([key]) => key !== 'hash')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(config.telegramBotToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'))) {
      return res.status(401).json({ success: false, message: 'Telegram Mini App data could not be verified.' });
    }
    const now = Math.floor(Date.now() / 1000);
    const authDate = Number(params.get('auth_date'));
    if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > 600) {
      return res.status(401).json({ success: false, message: 'Telegram Mini App data has expired. Reopen it and try again.' });
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
    const contact = db.prepare(`
      SELECT phone FROM telegram_registration_contacts
      WHERE telegram_user_id = ? AND expires_at > datetime('now')
    `).get(String(telegramUser.id));
    if (!contact) return res.json({ success: true, data: { phone: '' } });
    db.prepare('DELETE FROM telegram_registration_contacts WHERE telegram_user_id = ?').run(String(telegramUser.id));
    res.json({ success: true, data: { phone: contact.phone } });
  } catch (error) {
    console.error('Telegram registration phone lookup failed:', error.message);
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
        telegramConfigured: Boolean(config.telegramBotToken),
        telegramWebhookConfigured: safeConfig(config).telegramWebhookConfigured,
        rootTelegramChatConfigured: Boolean(config.rootTelegramChatId),
        telegramLoginWidgetConfigured: Boolean(config.telegramBotToken && config.telegramBotUsername),
        telegramBotUsername: config.telegramBotToken && config.telegramBotUsername ? config.telegramBotUsername : '',
        telegramWidgetMethods: getTelegramWidgetMethods(config),
        supportTelegramUsername: config.supportTelegramUsername || '',
        smsProvider: config.smsProvider || 'custom',
        purposeMethods: getPurposeMethods(config),
      },
    });
  } catch (error) {
    responseError(res, error);
  }
};

export const saveOtpSettings = (req, res) => {
  try {
    const current = getConfig();
    const requestedPurposeMethods = req.body.purposeMethods;
    const purposeMethods = getPurposeMethods({
      purposeMethods: requestedPurposeMethods || current.purposeMethods,
    });
    const requestedTelegramWidgetMethods = req.body.telegramWidgetMethods;
    const telegramWidgetMethods = getTelegramWidgetMethods({
      telegramWidgetMethods: requestedTelegramWidgetMethods || current.telegramWidgetMethods,
    });
    if (requestedPurposeMethods && OTP_PURPOSE_METHODS.some(purpose =>
      OTP_CHANNELS.some(channel => typeof requestedPurposeMethods?.[purpose]?.[channel] !== 'boolean'))) {
      return res.status(400).json({ success: false, message: 'OTP provider switches are invalid. Set each purpose and provider switch to enabled or disabled.' });
    }
    if (requestedTelegramWidgetMethods && TELEGRAM_WIDGET_PURPOSES.some(purpose =>
      typeof requestedTelegramWidgetMethods?.[purpose] !== 'boolean')) {
      return res.status(400).json({ success: false, message: 'Telegram Login Widget switches are invalid. Set each form switch to enabled or disabled.' });
    }
    const config = {
      smsProvider: ['custom', 'ethiopian_gateway', 'twilio'].includes(req.body.smsProvider)
        ? req.body.smsProvider
        : current.smsProvider || 'custom',
      smsEndpoint: String(req.body.smsEndpoint ?? current.smsEndpoint ?? '').trim(),
      smsApiToken: String(req.body.smsApiToken || current.smsApiToken || '').trim(),
      smsAuthHeader: String(req.body.smsAuthHeader ?? current.smsAuthHeader ?? 'Authorization').trim(),
      smsAuthPrefix: String(req.body.smsAuthPrefix ?? current.smsAuthPrefix ?? 'Bearer '),
      smsSenderId: String(req.body.smsSenderId ?? current.smsSenderId ?? '').trim(),
      smsAccountSid: String(req.body.smsAccountSid ?? current.smsAccountSid ?? '').trim(),
      smsMessagingServiceSid: String(req.body.smsMessagingServiceSid ?? current.smsMessagingServiceSid ?? '').trim(),
      smsBodyTemplate: String(req.body.smsBodyTemplate ?? current.smsBodyTemplate ?? '{"to":"{{phone}}","message":"{{message}}","sender":"{{sender}}"}'),
      purposeMethods,
      telegramWidgetMethods,
      telegramBotToken: String(req.body.telegramBotToken || current.telegramBotToken || '').trim(),
      telegramBotUsername: String(req.body.telegramBotUsername ?? current.telegramBotUsername ?? '').trim().replace(/^@/, ''),
      telegramWebhookUrl: String(req.body.telegramWebhookUrl ?? current.telegramWebhookUrl ?? '').trim(),
      telegramWebhookSecret: String(req.body.telegramWebhookSecret || current.telegramWebhookSecret || '').trim(),
      telegramWebhookRegistered: current.telegramWebhookRegistered === true &&
        String(req.body.telegramWebhookUrl ?? current.telegramWebhookUrl ?? '').trim() === String(current.telegramWebhookUrl || '') &&
        String(req.body.telegramWebhookSecret || current.telegramWebhookSecret || '').trim() === String(current.telegramWebhookSecret || '') &&
        String(req.body.telegramBotToken || current.telegramBotToken || '').trim() === String(current.telegramBotToken || ''),
      supportTelegramUsername: String(req.body.supportTelegramUsername ?? current.supportTelegramUsername ?? '').trim().replace(/^@/, ''),
      rootTelegramChatId: String(req.body.rootTelegramChatId ?? current.rootTelegramChatId ?? '').trim(),
      firebaseApiKey: String(req.body.firebaseApiKey ?? current.firebaseApiKey ?? '').trim(),
      firebaseAuthDomain: String(req.body.firebaseAuthDomain ?? current.firebaseAuthDomain ?? '').trim(),
      firebaseProjectId: String(req.body.firebaseProjectId ?? current.firebaseProjectId ?? '').trim(),
      firebaseAppId: String(req.body.firebaseAppId ?? current.firebaseAppId ?? '').trim(),
      resendApiKey: String(req.body.resendApiKey || current.resendApiKey || '').trim(),
      resendFromEmail: String(req.body.resendFromEmail ?? current.resendFromEmail ?? '').trim(),
    };
    if (config.smsProvider !== 'twilio' && config.smsEndpoint && !/^https:\/\//i.test(config.smsEndpoint)) {
      return res.status(400).json({ success: false, message: 'SMS provider endpoint must use HTTPS.' });
    }
    if (config.smsProvider !== 'twilio' && config.smsEndpoint && !config.smsApiToken) {
      return res.status(400).json({ success: false, message: 'Enter the SMS provider API token before saving the endpoint.' });
    }
    if (config.smsProvider === 'twilio' && (config.smsAccountSid || config.smsApiToken || config.smsSenderId || config.smsMessagingServiceSid)) {
      if (!/^AC[a-f0-9]{32}$/i.test(config.smsAccountSid) || !config.smsApiToken || (!config.smsSenderId && !/^MG[a-f0-9]{32}$/i.test(config.smsMessagingServiceSid))) {
        return res.status(400).json({ success: false, message: 'Enter a valid Twilio Account SID and Auth Token, plus a sender number or Messaging Service SID.' });
      }
      if (config.smsMessagingServiceSid && !/^MG[a-f0-9]{32}$/i.test(config.smsMessagingServiceSid)) {
        return res.status(400).json({ success: false, message: 'Twilio Messaging Service SID must begin with MG and contain 32 hexadecimal characters.' });
      }
    }
    if (config.telegramBotToken && !/^\d+:[A-Za-z0-9_-]+$/.test(config.telegramBotToken)) {
      return res.status(400).json({ success: false, message: 'Telegram bot token format is invalid.' });
    }
    if (config.telegramBotUsername && !/^[A-Za-z0-9_]{5,32}bot$/i.test(config.telegramBotUsername)) {
      return res.status(400).json({ success: false, message: 'Telegram bot username must be the bot username ending in "bot".' });
    }
    if (config.telegramBotUsername && !config.telegramBotToken) {
      return res.status(400).json({ success: false, message: 'Enter the Telegram bot token before enabling Login Widget sign-in.' });
    }
    if (config.telegramWebhookUrl && !/^https:\/\/[^\s]+\/auth\/telegram\/webhook$/i.test(config.telegramWebhookUrl)) {
      return res.status(400).json({ success: false, message: 'Telegram webhook URL must be a public HTTPS URL ending in /auth/telegram/webhook.' });
    }
    if (config.telegramWebhookSecret && !/^[A-Za-z0-9_-]{1,256}$/.test(config.telegramWebhookSecret)) {
      return res.status(400).json({ success: false, message: 'Telegram webhook secret must contain 1–256 letters, numbers, underscores, or hyphens.' });
    }
    if (config.supportTelegramUsername && !/^[A-Za-z0-9_]{5,32}$/.test(config.supportTelegramUsername)) {
      return res.status(400).json({ success: false, message: 'Support Telegram username must contain 5–32 letters, numbers, or underscores.' });
    }
    if (config.rootTelegramChatId && !/^[1-9]\d{0,18}$/.test(config.rootTelegramChatId)) {
      return res.status(400).json({ success: false, message: 'Root Telegram chat ID must be a positive numeric private chat ID.' });
    }
    const firebaseFields = [config.firebaseApiKey, config.firebaseAuthDomain, config.firebaseProjectId, config.firebaseAppId];
    if (firebaseFields.some(Boolean) && firebaseFields.some(value => !value)) {
      return res.status(400).json({ success: false, message: 'Enter the Firebase API key, auth domain, project ID, and app ID to enable Firebase SMS.' });
    }
    if (config.resendFromEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.resendFromEmail)) {
      return res.status(400).json({ success: false, message: 'Enter a valid verified sender email address for Resend.' });
    }
    if (config.resendFromEmail && !config.resendApiKey) {
      return res.status(400).json({ success: false, message: 'Enter the Resend API key before saving the sender email.' });
    }
    if (config.resendApiKey && !config.resendFromEmail) {
      return res.status(400).json({ success: false, message: 'Enter the verified sender email address before saving the Resend API key.' });
    }

    db.prepare(`
      INSERT INTO otp_settings (id, encrypted_config, updated_at)
      VALUES (1, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET encrypted_config = excluded.encrypted_config, updated_at = excluded.updated_at
    `).run(encryptConfig(config));
    res.json({ success: true, message: 'OTP delivery settings saved.', data: safeConfig(config) });
  } catch (error) {
    responseError(res, error);
  }
};

const getUpgradeAccessHash = (requestId, accessKey) => hashCode(requestId, accessKey);

const createAccountApprovalRequest = async (req, res, requestType) => {
  try {
    ensureSchema();
    getSecret();
    const username = String(req.body?.username || '').trim();
    const fullName = String(req.body?.fullName || '').trim();
    const phone = String(req.body?.phone || '').trim();
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const referralCode = String(req.body?.referralCode || '').trim().toUpperCase();
    const requestIp = String(req.ip || req.socket.remoteAddress || '').slice(0, 80);
    const isRegistration = requestType === 'registration';
    const isPasswordReset = requestType === 'password_reset';
    const validPhone = isRegistration || isPasswordReset
      ? /^[0-9+\-\s()]{7,24}$/.test(phone) && /^\d{7,15}$/.test(normalizePhone(phone))
      : /^[0-9+\-\s()]{6,24}$/.test(phone);
    if ((requestType === 'upgrade' && !fullName) || fullName.length > 120 ||
      ((isRegistration || isPasswordReset) && !/^[A-Za-z0-9_.-]{3,40}$/.test(username)) ||
      !validPhone || password.length < 6 || password.length > 128) {
      return res.status(400).json({
        success: false,
        message: isRegistration || isPasswordReset
          ? `Enter a valid username, phone number, and a ${isPasswordReset ? 'new ' : ''}password of at least 6 characters.`
          : 'Enter your full name, a valid phone number, and a password of at least 6 characters.',
      });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    }
    if (requestType === 'registration' && referralCode &&
      !db.prepare('SELECT 1 FROM social_referrals WHERE referral_code = ?').get(referralCode)) {
      return res.status(400).json({ success: false, message: 'The invite link is invalid or expired.' });
    }
    if (isPasswordReset) {
      const targetUser = db.prepare(`
        SELECT _id, role FROM users
        WHERE lower(trim(username)) = lower(?) AND ${PHONE_SQL} = ? AND is_active = 1
      `).get(username, normalizePhone(phone));
      if (!targetUser || ['root', 'admin'].includes(String(targetUser.role || '').toLowerCase())) {
        return res.status(404).json({ success: false, message: 'No active user account matches that username and phone number.' });
      }
    }
    const recent = db.prepare(`
      SELECT COUNT(*) AS count FROM guest_upgrade_requests
      WHERE request_ip = ? AND created_at >= datetime('now', '-15 minutes')
    `).get(requestIp).count;
    if (recent >= 5) {
      return res.status(429).json({
        success: false,
        message: isRegistration
          ? 'Too many signup requests. Wait 15 minutes and try again.'
          : isPasswordReset
          ? 'Too many password reset requests. Wait 15 minutes and try again.'
          : 'Too many upgrade requests. Wait 15 minutes and try again.',
      });
    }
    const phoneTaken = isPasswordReset ? null : findUserByPhone(phone);
    const emailTaken = email && findUserByEmail(email);
    const usernameTaken = requestType === 'registration' &&
      db.prepare('SELECT 1 FROM users WHERE lower(trim(username)) = lower(?)').get(username);
    if (usernameTaken) {
      return res.status(409).json({ success: false, message: 'An account already exists with this username.' });
    }
    if (phoneTaken || emailTaken) {
      return res.status(409).json({ success: false, message: 'An account already exists with this phone number or email address.' });
    }
    const existing = db.prepare(`
      SELECT 1 FROM guest_upgrade_requests
      WHERE request_type = ? AND ${PHONE_SQL} = ? AND status IN ('pending', 'approved')
        AND datetime(expires_at) > datetime('now')
      LIMIT 1
    `).get(requestType, normalizePhone(phone));
    if (existing) {
      return res.status(409).json({
        success: false,
        message: isRegistration
          ? 'A signup request for this phone number is already awaiting approval.'
          : isPasswordReset
          ? 'A password reset request for this phone number is already awaiting approval.'
          : 'An upgrade request for this phone number is already awaiting approval.',
      });
    }
    if (requestType === 'registration' || isPasswordReset) {
      const existingUsernameRequest = db.prepare(`
        SELECT 1 FROM guest_upgrade_requests
        WHERE request_type = ? AND lower(trim(username)) = lower(?) AND status IN ('pending', 'approved')
          AND datetime(expires_at) > datetime('now')
        LIMIT 1
      `).get(requestType, username);
      if (existingUsernameRequest) {
        return res.status(409).json({
          success: false,
          message: isPasswordReset
            ? 'A password reset request for this username is already awaiting approval.'
            : 'A signup request for this username is already awaiting approval.',
        });
      }
    }
    const requestId = crypto.randomUUID();
    const accessKey = crypto.randomBytes(32).toString('hex');
    const passwordHash = await bcrypt.hash(password, 10);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO guest_upgrade_requests
        (request_id, access_hash, request_type, username, full_name, phone, email, password_hash, referral_code, expires_at, request_ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId,
      getUpgradeAccessHash(requestId, accessKey),
      requestType,
      isRegistration || isPasswordReset ? username : null,
      fullName,
      phone,
      email || null,
      passwordHash,
      referralCode || null,
      expiresAt,
      requestIp,
    );
    res.status(201).json({
      success: true,
      message: requestType === 'registration'
        ? 'Signup request submitted for Root approval.'
        : isPasswordReset
        ? 'Password reset request submitted for Root approval.'
        : 'Upgrade request submitted for Root approval.',
      data: { requestId, accessKey },
    });
  } catch (error) {
    console.error('Account approval request failed:', error.message);
    responseError(res, error);
  }
};

export const createGuestUpgradeRequest = (req, res) => createAccountApprovalRequest(req, res, 'upgrade');
export const createRegistrationApprovalRequest = (req, res) => createAccountApprovalRequest(req, res, 'registration');
export const createPasswordResetApprovalRequest = (req, res) => createAccountApprovalRequest(req, res, 'password_reset');

const getGuestUpgradeRequest = (requestId, accessKey) => {
  if (typeof requestId !== 'string' || typeof accessKey !== 'string' || !/^[a-f0-9]{64}$/i.test(accessKey)) return null;
  const request = db.prepare('SELECT * FROM guest_upgrade_requests WHERE request_id = ?').get(requestId);
  if (!request) return null;
  const expected = Buffer.from(request.access_hash, 'hex');
  const received = Buffer.from(getUpgradeAccessHash(requestId, accessKey), 'hex');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received) ? request : null;
};

const getAccountApprovalStatus = (req, res, requestType) => {
  try {
    ensureSchema();
    getSecret();
    const request = getGuestUpgradeRequest(req.params.requestId, String(req.query.accessKey || ''));
    if (!request || request.request_type !== requestType) {
      return res.status(404).json({ success: false, message: 'Account request not found.' });
    }
    const requestExpiry = request.status === 'approved'
      ? request.otp_expires_at || request.expires_at
      : request.expires_at;
    if (Date.parse(requestExpiry) <= Date.now() && request.status !== 'completed') {
      return res.status(410).json({ success: false, message: 'This account request has expired. Please submit a new request.' });
    }
    const otp = request.status === 'approved' && request.otp_encrypted
      ? decryptConfig(request.otp_encrypted).code
      : '';
    res.json({
      success: true,
      data: {
        requestId: request.request_id,
        fullName: request.full_name,
        username: request.username || '',
        phone: request.phone,
        email: request.email || '',
        status: request.status,
        otp,
        expiresAt: request.expires_at,
        otpExpiresAt: request.otp_expires_at || '',
      },
    });
  } catch (error) {
    responseError(res, error);
  }
};

export const getGuestUpgradeStatus = (req, res) => getAccountApprovalStatus(req, res, 'upgrade');
export const getRegistrationApprovalStatus = (req, res) => getAccountApprovalStatus(req, res, 'registration');
export const getPasswordResetApprovalStatus = (req, res) => getAccountApprovalStatus(req, res, 'password_reset');

const verifyAccountApprovalOtp = async (req, res, requestType) => {
  try {
    ensureSchema();
    getSecret();
    const request = getGuestUpgradeRequest(req.params.requestId, String(req.body?.accessKey || ''));
    if (!request || request.request_type !== requestType || request.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'This account request is not approved or is invalid.' });
    }
    if (Date.parse(request.otp_expires_at) <= Date.now()) {
      return res.status(410).json({ success: false, message: 'This approval code has expired. Contact support to request a new one.' });
    }
    if (request.attempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ success: false, message: 'Too many incorrect approval codes. Contact support to request another one.' });
    }
    const code = String(req.body?.code || '').trim();
    const expected = Buffer.from(request.otp_hash || '', 'hex');
    const received = Buffer.from(hashCode(request.request_id, code), 'hex');
    if (!/^\d{6}$/.test(code) || expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      db.prepare('UPDATE guest_upgrade_requests SET attempts = attempts + 1 WHERE request_id = ?')
        .run(request.request_id);
      return res.status(400).json({ success: false, message: 'The approval code is incorrect.' });
    }
    const phoneTaken = requestType === 'password_reset' ? null : findUserByPhone(request.phone);
    const emailTaken = request.email && findUserByEmail(request.email);
    const usernameTaken = requestType === 'registration' &&
      db.prepare('SELECT 1 FROM users WHERE lower(trim(username)) = lower(?)').get(request.username);
    if (usernameTaken) {
      return res.status(409).json({ success: false, message: 'An account already exists with this username.' });
    }
    if (phoneTaken || emailTaken) {
      return res.status(409).json({ success: false, message: 'An account already exists with this phone number or email address.' });
    }
    if (requestType === 'registration' && request.referral_code &&
      !db.prepare('SELECT 1 FROM social_referrals WHERE referral_code = ?').get(request.referral_code)) {
      return res.status(400).json({ success: false, message: 'The invite link is invalid or expired.' });
    }
    if (requestType === 'password_reset') {
      const targetUser = db.prepare(`
        SELECT _id, role FROM users
        WHERE lower(trim(username)) = lower(?) AND ${PHONE_SQL} = ? AND is_active = 1
      `).get(request.username, normalizePhone(request.phone));
      if (!targetUser || ['root', 'admin'].includes(String(targetUser.role || '').toLowerCase())) {
        return res.status(404).json({ success: false, message: 'The account no longer matches this password reset request.' });
      }
      const transaction = db.transaction(() => {
        const updateRequest = db.prepare(`
          UPDATE guest_upgrade_requests SET status = 'completed', completed_at = datetime('now')
          WHERE request_id = ? AND status = 'approved'
        `).run(request.request_id);
        if (!updateRequest.changes) throw new Error('This password reset request has already been completed.');
        db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE _id = ?")
          .run(request.password_hash, targetUser._id);
      });
      transaction();
      return res.json({ success: true, message: 'Password reset successfully. Sign in with your new password.' });
    }
    const usernameBase = `user_${normalizePhone(request.phone)}`;
    let username = usernameBase;
    while (requestType === 'upgrade' && db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      username = `${usernameBase}_${crypto.randomInt(1000, 10000)}`;
    }
    const transaction = db.transaction(() => {
      const update = db.prepare(`
        UPDATE guest_upgrade_requests SET status = 'completed', completed_at = datetime('now')
        WHERE request_id = ? AND status = 'approved'
      `).run(request.request_id);
      if (!update.changes) throw new Error('This upgrade request has already been completed.');
      const insert = requestType === 'registration'
        ? db.prepare(`
          INSERT INTO users (username, password_hash, full_name, role, email, phone, is_active, created_at, created_by_role)
          VALUES (?, ?, ?, 'user', ?, ?, 1, datetime('now'), 'self')
        `).run(request.username, request.password_hash, request.full_name || null, request.email, request.phone)
        : db.prepare(`
          INSERT INTO users (username, password_hash, full_name, role, email, phone, is_active, created_at, created_by_role)
          VALUES (?, ?, ?, 'user', ?, ?, 1, datetime('now'), 'root')
        `).run(username, request.password_hash, request.full_name, request.email, request.phone);
      const user = db.prepare(`
        SELECT _id AS id, username, email, full_name, role, permissions, position, phone, is_active
        FROM users WHERE _id = ?
      `).get(insert.lastInsertRowid);
      return requestType === 'registration'
        ? { id: user.id, username: user.username }
        : issueSession(user);
    });
    const result = transaction();
    if (requestType === 'registration') {
      registerReferredUser(result.id, request.referral_code || '');
      awardDailyLoginCoins(result.id);
      ensureReferralCode(result.id);
      res.json({ success: true, message: 'Account created successfully. Please sign in.', data: result });
    } else {
      res.json({ success: true, message: 'Guest account upgraded successfully.', data: result });
    }
  } catch (error) {
    console.error('Account approval verification failed:', error.message);
    responseError(res, error);
  }
};

export const verifyGuestUpgradeOtp = (req, res) => verifyAccountApprovalOtp(req, res, 'upgrade');
export const verifyRegistrationApprovalOtp = (req, res) => verifyAccountApprovalOtp(req, res, 'registration');
export const verifyPasswordResetApprovalOtp = (req, res) => verifyAccountApprovalOtp(req, res, 'password_reset');

export const getRootGuestUpgradeRequests = (req, res) => {
  try {
    ensureSchema();
    const requests = db.prepare(`
      SELECT request_id AS id, request_type AS requestType, username, full_name AS fullName, phone, email, status,
             expires_at AS expiresAt, otp_expires_at AS otpExpiresAt,
             created_at AS createdAt, approved_at AS approvedAt, completed_at AS completedAt
      FROM guest_upgrade_requests
      ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, created_at DESC
      LIMIT 200
    `).all();
    res.json({ success: true, data: requests });
  } catch (error) {
    responseError(res, error);
  }
};

export const approveRootGuestUpgrade = (req, res) => {
  try {
    ensureSchema();
    const request = db.prepare('SELECT * FROM guest_upgrade_requests WHERE request_id = ?').get(req.params.requestId);
    if (!request) return res.status(404).json({ success: false, message: 'Upgrade request not found.' });
    if (request.status !== 'pending') return res.status(409).json({ success: false, message: 'This upgrade request has already been processed.' });
    if (Date.parse(request.expires_at) <= Date.now()) return res.status(410).json({ success: false, message: 'This upgrade request has expired.' });
    const code = String(crypto.randomInt(100000, 1000000));
    const otpExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const update = db.prepare(`
      UPDATE guest_upgrade_requests
      SET status = 'approved', otp_hash = ?, otp_encrypted = ?, otp_expires_at = ?, approved_at = datetime('now')
      WHERE request_id = ? AND status = 'pending'
    `).run(hashCode(request.request_id, code), encryptConfig({ code }), otpExpiresAt, request.request_id);
    if (!update.changes) return res.status(409).json({ success: false, message: 'This upgrade request has already been processed.' });
    res.json({
      success: true,
      message: request.request_type === 'registration'
        ? 'Signup approved. The OTP is now available in the registration form.'
        : request.request_type === 'password_reset'
        ? 'Password reset approved. The OTP is now available in the reset form.'
        : 'Guest upgrade approved. The OTP is now available in the upgrade form.',
      data: { id: request.request_id },
    });
  } catch (error) {
    console.error('Guest upgrade approval failed:', error.message);
    responseError(res, error);
  }
};

const getVerifiedTelegramWidgetId = (telegramUser, config) => {
  if (!config.telegramBotToken || !config.telegramBotUsername) {
    throw new Error('Telegram Login Widget is not configured. Ask an administrator to configure the bot token and username in Root Dashboard → OTP API.');
  }
  if (!telegramUser || typeof telegramUser !== 'object' || Array.isArray(telegramUser)) {
    throw new Error('Connect your Telegram account before requesting a Telegram verification code.');
  }
  const { hash: receivedHash, ...userFields } = telegramUser;
  const telegramId = Number(telegramUser.id);
  const authDate = Number(telegramUser.auth_date);
  if (!/^[a-f0-9]{64}$/i.test(String(receivedHash || ''))
    || !Number.isSafeInteger(telegramId) || telegramId <= 0
    || !Number.isSafeInteger(authDate)) {
    throw new Error('Telegram sign-in data could not be verified. Connect your Telegram account again.');
  }
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 30 || now - authDate > 600) {
    throw new Error('Telegram sign-in data has expired. Connect your Telegram account again.');
  }
  const dataCheckString = Object.entries(userFields)
    .map(([key, value]) => [key, String(value)])
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHash('sha256').update(config.telegramBotToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(String(receivedHash), 'hex'), Buffer.from(expectedHash, 'hex'))) {
    throw new Error('Telegram sign-in data could not be verified. Connect your Telegram account again.');
  }
  return String(telegramId);
};

export const sendOtp = async (req, res) => {
  try {
    ensureSchema();
    const { phone: rawPhone, email: rawEmail, purpose, channel, telegramUser, fullName, password } = req.body;
    const submittedPhone = String(rawPhone || '').trim();
    const submittedTarget = String(channel === 'email' ? (rawEmail || rawPhone) : rawPhone || '').trim();
    const telegramRegistration = purpose === 'registration' && channel === 'telegram';
    const telegramPasswordReset = purpose === 'password_reset' && channel === 'telegram' && Boolean(telegramUser);
    const phone = channel === 'email' ? '' : submittedTarget;
    const email = channel === 'email' ? normalizeEmail(submittedTarget) : '';
    const normalizedPhone = normalizePhone(phone);
    const normalizedSubmittedPhone = normalizePhone(submittedPhone);
    const allowedPurposes = ['login', 'password_reset', 'root_login', 'root_password_reset', 'upgrade', 'registration'];
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
    const validPhone = /^[+\d\s()-]{7,24}$/.test(phone) && /^\d{7,15}$/.test(normalizedPhone);
    const validRegistrationPhone = /^[+\d\s()-]{7,24}$/.test(submittedPhone) &&
      /^\d{7,15}$/.test(normalizedSubmittedPhone);
    if ((channel === 'email' && !validEmail) ||
      (purpose === 'registration' && rawEmail && (typeof rawEmail !== 'string' || rawEmail.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail))) ||
      (channel !== 'email' && !telegramRegistration && !telegramPasswordReset && !validPhone) ||
      (purpose === 'registration' && !validRegistrationPhone)) {
      return res.status(400).json({
        success: false,
        message: channel === 'email' && !validEmail
          ? 'Enter a valid email address.'
          : 'Enter a valid phone number for account creation.',
      });
    }
    if (!allowedPurposes.includes(purpose) || !['sms', 'telegram', 'firebase_sms', 'email'].includes(channel)) {
      return res.status(400).json({ success: false, message: 'Choose a valid verification purpose and delivery method.' });
    }
    if (channel === 'email' && !['login', 'password_reset', 'root_login', 'root_password_reset', 'upgrade', 'registration'].includes(purpose)) {
      return res.status(400).json({ success: false, message: 'Email delivery is not available for this verification purpose.' });
    }
    if (channel === 'firebase_sms' && !['login', 'password_reset', 'root_login', 'root_password_reset', 'upgrade', 'registration'].includes(purpose)) {
      return res.status(400).json({ success: false, message: 'Firebase SMS is available for account creation, guest upgrades, login, and password reset.' });
    }

    const config = getConfig();
    if (!isPurposeMethodEnabled(config, purpose, channel)) {
      return res.status(403).json({ success: false, message: `${channel === 'firebase_sms' ? 'Firebase SMS' : channel[0].toUpperCase() + channel.slice(1)} verification is disabled for ${purpose.replaceAll('_', ' ')}.` });
    }
    let user = null;
    let data = {};
    if (purpose === 'registration') {
      if (telegramRegistration) {
        if (!isTelegramWidgetEnabled(config, 'registration')) {
          return res.status(403).json({ success: false, message: 'Telegram account creation is hidden in Root Dashboard → OTP API.' });
        }
        if (!safeConfig(config).telegramLoginWidgetConfigured) {
          return res.status(503).json({ success: false, message: 'Telegram Login Widget is not configured. Ask an administrator to finish setup in Root Dashboard → OTP API.' });
        }
        data = {
          contactType: 'telegram',
          telegramChatId: getVerifiedTelegramWidgetId(telegramUser, config),
          email: '',
          phone: submittedPhone,
        };
      } else {
        const existingAccount = channel === 'email'
          ? db.prepare('SELECT 1 FROM users WHERE lower(trim(email)) = ?').get(email)
          : db.prepare(`SELECT 1 FROM users WHERE ${PHONE_SQL} = ?`).get(normalizedPhone);
        if (existingAccount) {
          return res.status(409).json({ success: false, message: channel === 'email'
            ? 'An account already uses this email address. Try logging in or resetting its password.'
            : 'An account already uses this phone number. Try logging in or resetting its password.' });
        }
        data = {
          contactType: channel === 'email' ? 'email' : 'phone',
          email: rawEmail ? normalizeEmail(rawEmail) : (channel === 'email' ? email : ''),
          phone: channel === 'email' ? submittedPhone : phone,
        };
      }
      if (telegramRegistration && db.prepare('SELECT 1 FROM users WHERE telegram_chat_id = ?').get(data.telegramChatId)) {
        return res.status(409).json({ success: false, message: 'This Telegram account is already linked to an account. Try logging in instead.' });
      }
      if (db.prepare(`SELECT 1 FROM users WHERE ${PHONE_SQL} = ?`).get(normalizedSubmittedPhone)) {
        return res.status(409).json({ success: false, message: 'An account already uses this phone number. Try logging in or resetting its password.' });
      }
    } else if (purpose === 'upgrade') {
      if (!String(fullName || '').trim() || typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ success: false, message: 'Full name and a password of at least 6 characters are required.' });
      }
      const existingAccount = channel === 'email'
        ? db.prepare('SELECT 1 FROM users WHERE lower(trim(email)) = ?').get(email)
        : db.prepare(`SELECT 1 FROM users WHERE ${PHONE_SQL} = ?`).get(normalizedPhone);
      if (existingAccount) {
        return res.status(409).json({ success: false, message: channel === 'email'
          ? 'An account already uses this email address. Try logging in or resetting its password.'
          : 'An account already uses this phone number. Try logging in or resetting its password.' });
      }
      data = {
        fullName: String(fullName).trim(),
        passwordHash: await bcrypt.hash(password, 10),
        contactType: channel === 'email' ? 'email' : 'phone',
        email: channel === 'email' ? email : '',
        phone: channel === 'email' ? '' : phone,
        telegramChatId: '',
      };
    } else {
      if (telegramPasswordReset) {
        if (!isTelegramWidgetEnabled(config, 'password_reset')) {
          return res.status(403).json({ success: false, message: 'Telegram password reset is hidden in Root Dashboard → OTP API.' });
        }
        if (!safeConfig(config).telegramLoginWidgetConfigured) {
          return res.status(503).json({ success: false, message: 'Telegram Login Widget is not configured. Ask an administrator to finish setup in Root Dashboard → OTP API.' });
        }
        const chatId = getVerifiedTelegramWidgetId(telegramUser, config);
        user = db.prepare(`
          SELECT _id AS id, username, email, password_hash, full_name, role, permissions,
                 position, phone, telegram_chat_id, is_active
          FROM users
          WHERE telegram_chat_id = ? AND is_active = 1 AND lower(role) NOT IN ('root', 'admin')
        `).get(chatId);
      } else {
        user = channel === 'email' ? findUserByEmail(email) : findUserByPhone(phone);
      }
      if (!user) {
        return res.status(404).json({
          success: false,
          message: telegramPasswordReset
            ? 'No active account is linked to this Telegram account.'
            : channel === 'email'
            ? 'No active account is registered with this email address.'
            : 'No active account is registered with this phone number.',
        });
      }
      const isRootPurpose = purpose.startsWith('root_');
      if (isRootPurpose && !['root', 'admin'].includes(String(user.role).toLowerCase())) {
        return res.status(403).json({ success: false, message: 'This account is not a root account.' });
      }
      if (!isRootPurpose && ['root', 'admin'].includes(String(user.role).toLowerCase())) {
        return res.status(403).json({ success: false, message: 'Use the Root Portal to verify this account.' });
      }
      data = { userId: user.id };
    }
    const rateLimitTarget = telegramRegistration
      ? data.telegramChatId
      : telegramPasswordReset
        ? user.telegram_chat_id
        : channel === 'email' ? email : normalizedPhone;

    const recentCount = db.prepare(`
      SELECT COUNT(*) AS count FROM otp_challenges
      WHERE phone = ? AND created_at >= datetime('now', '-15 minutes')
    `).get(rateLimitTarget).count;
    if (recentCount >= 3) {
      return res.status(429).json({ success: false, message: 'Too many codes requested. Wait 15 minutes and try again.' });
    }
    const requestIp = String(req.ip || req.socket.remoteAddress || '').slice(0, 80);
    const recentIpCount = db.prepare(`
      SELECT COUNT(*) AS count FROM otp_challenges
      WHERE request_ip = ? AND created_at >= datetime('now', '-15 minutes')
    `).get(requestIp).count;
    if (recentIpCount >= 10) {
      return res.status(429).json({ success: false, message: 'Too many verification requests from this connection. Wait 15 minutes and try again.' });
    }

    const isRootPurpose = purpose.startsWith('root_');
    if (purpose === 'upgrade' && channel === 'telegram') {
      if (!isTelegramWidgetEnabled(config, 'upgrade')) {
        return res.status(403).json({ success: false, message: 'Telegram guest upgrade is hidden in Root Dashboard → OTP API.' });
      }
      data.telegramChatId = getVerifiedTelegramWidgetId(telegramUser, config);
    }
    const chatId = isRootPurpose
      ? String(config.rootTelegramChatId || '').trim()
      : purpose === 'upgrade' || telegramRegistration
      ? String(data.telegramChatId || '').trim()
      : String(user?.telegram_chat_id || '').trim();
    if (channel === 'telegram' && isRootPurpose && !chatId) {
      throw new Error('Root Telegram chat ID is not configured. Add the private chat ID in Root Dashboard → OTP API → OTP Delivery Settings.');
    }
    if (channel === 'firebase_sms' && !safeConfig(config).firebaseConfigured) {
      throw new Error('Firebase SMS is not configured. Ask the administrator to add Firebase web app settings in Root Dashboard → OTP API.');
    }
    if (channel === 'email' && !safeConfig(config).resendConfigured) {
      throw new Error('Email OTP is not configured. Ask the administrator to configure Resend in Root Dashboard → OTP API.');
    }
    const code = String(crypto.randomInt(100000, 1000000));
    const delivery = channel === 'sms'
      ? sendSMS(config, phone, code)
      : channel === 'telegram'
      ? sendTelegram(config, chatId, code)
      : channel === 'email'
      ? sendEmailOtp(config, email, code)
      : Promise.resolve();
    await delivery;

    const challengeId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + OTP_LIFETIME_MINUTES * 60 * 1000).toISOString();
    db.prepare(`
      UPDATE otp_challenges SET consumed_at = datetime('now')
      WHERE phone = ? AND purpose = ? AND consumed_at IS NULL
    `).run(rateLimitTarget, purpose);
    db.prepare(`
      INSERT INTO otp_challenges (challenge_id, phone, request_ip, purpose, channel, code_hash, data_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(challengeId, rateLimitTarget, requestIp, purpose, channel, hashCode(challengeId, code), JSON.stringify(data), expiresAt);
    res.json({
      success: true,
      message: channel === 'firebase_sms'
        ? 'Firebase SMS verification is ready.'
        : `Verification code sent by ${channel === 'sms' ? 'SMS' : channel === 'telegram' ? 'Telegram' : 'email'}.`,
      data: { challengeId, expiresAt },
    });
  } catch (error) {
    console.error('OTP delivery failed:', error.message);
    responseError(res, error);
  }
};

export const verifyOtp = async (req, res) => {
  try {
    ensureSchema();
    getSecret();
    const { challengeId, code, newPassword } = req.body;
    const challenge = db.prepare('SELECT * FROM otp_challenges WHERE challenge_id = ?').get(challengeId);
    if (!challenge || challenge.consumed_at) {
      return res.status(400).json({ success: false, message: 'This verification code is invalid or already used.' });
    }
    if (!isPurposeMethodEnabled(getConfig(), challenge.purpose, challenge.channel)) {
      return res.status(403).json({ success: false, message: 'This OTP provider is disabled for the verification purpose.' });
    }
    if (challenge.channel === 'firebase_sms') {
      return res.status(400).json({ success: false, message: 'Verify this code through Firebase SMS.' });
    }
    if (Date.parse(challenge.expires_at) <= Date.now()) {
      return res.status(400).json({ success: false, message: 'This verification code has expired. Request a new one.' });
    }
    if (challenge.attempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ success: false, message: 'Too many incorrect codes. Request a new code.' });
    }
    const expectedHash = hashCode(challenge.challenge_id, String(code || '').trim());
    if (!/^\d{6}$/.test(String(code || '').trim()) || !crypto.timingSafeEqual(Buffer.from(challenge.code_hash, 'hex'), Buffer.from(expectedHash, 'hex'))) {
      db.prepare('UPDATE otp_challenges SET attempts = attempts + 1 WHERE challenge_id = ?').run(challenge.challenge_id);
      return res.status(400).json({ success: false, message: 'The verification code is incorrect.' });
    }

    const data = JSON.parse(challenge.data_json || '{}');
    let result;
    if (challenge.purpose === 'registration') {
      const contactExists = data.contactType === 'telegram'
        ? db.prepare('SELECT 1 FROM users WHERE telegram_chat_id = ?').get(data.telegramChatId)
        : data.contactType === 'email'
          ? db.prepare('SELECT 1 FROM users WHERE lower(trim(email)) = ?').get(data.email)
          : db.prepare(`SELECT 1 FROM users WHERE ${PHONE_SQL} = ?`).get(normalizePhone(data.phone));
      if (contactExists) {
        return res.status(409).json({ success: false, message: 'An account already uses this contact. Try logging in or resetting its password.' });
      }
      db.transaction(() => {
        const consume = db.prepare(`
          UPDATE otp_challenges SET consumed_at = datetime('now')
          WHERE challenge_id = ? AND consumed_at IS NULL AND attempts < ?
        `).run(challenge.challenge_id, MAX_OTP_ATTEMPTS);
        if (!consume.changes) {
          const error = new Error('This verification code is invalid or already used.');
          error.status = 400;
          throw error;
        }
        saveRegistrationTicket(challenge, data);
      })();
      result = { message: 'Contact verified. Complete account creation.', registrationChallengeId: challenge.challenge_id };
    } else if (challenge.purpose === 'upgrade') {
      const contactExists = data.contactType === 'email'
        ? db.prepare('SELECT 1 FROM users WHERE lower(trim(email)) = ?').get(data.email)
        : db.prepare(`SELECT 1 FROM users WHERE ${PHONE_SQL} = ?`).get(normalizePhone(data.phone));
      if (contactExists) {
        return res.status(409).json({ success: false, message: `An account has already been created with this ${data.contactType === 'email' ? 'email address' : 'phone number'}.` });
      }
      const usernameBase = data.contactType === 'email'
        ? `user_${String(data.email).split('@')[0].replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'account'}`
        : `user_${normalizePhone(data.phone)}`;
      let username = usernameBase;
      while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
        username = `${usernameBase}_${crypto.randomInt(1000, 10000)}`;
      }
      const insert = db.prepare(`
        INSERT INTO users (username, password_hash, full_name, role, email, phone, telegram_chat_id, is_active, created_at, created_by_role)
        VALUES (?, ?, ?, 'user', ?, ?, ?, 1, datetime('now'), 'self')
      `).run(username, data.passwordHash, data.fullName, data.email || null, data.phone || null, data.telegramChatId || null);
      const user = db.prepare(`
        SELECT _id AS id, username, email, full_name, role, permissions, position, phone, telegram_chat_id, is_active
        FROM users WHERE _id = ?
      `).get(insert.lastInsertRowid);
      result = issueSession(user);
    } else {
      const user = db.prepare(`
        SELECT _id AS id, username, email, password_hash, full_name, role, permissions,
               position, phone, telegram_chat_id, is_active
        FROM users WHERE _id = ? AND is_active = 1
      `).get(data.userId);
      if (!user) {
        return res.status(404).json({ success: false, message: 'The account is no longer active.' });
      }
      if (challenge.purpose === 'password_reset' || challenge.purpose === 'root_password_reset') {
        if (String(newPassword || '').length < 6) {
          return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
        }
        const passwordHash = await bcrypt.hash(newPassword, 10);
        db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE _id = ?")
          .run(passwordHash, user.id);
        result = { message: 'Password reset successfully.' };
      } else {
        const isRoot = challenge.purpose === 'root_login';
        result = issueSession(user, isRoot);
        db.prepare("UPDATE users SET last_login = datetime('now') WHERE _id = ?").run(user.id);
      }
    }

    db.prepare("UPDATE otp_challenges SET consumed_at = datetime('now') WHERE challenge_id = ?")
      .run(challenge.challenge_id);
    res.json({ success: true, message: result.message || 'Verification successful.', data: result });
  } catch (error) {
    console.error('OTP verification failed:', error.message);
    responseError(res, error);
  }
};

export const verifyFirebaseOtp = async (req, res) => {
  try {
    ensureSchema();
    getSecret();
    const { challengeId, idToken, newPassword } = req.body;
    if (typeof idToken !== 'string' || !idToken || idToken.length > 12000) {
      return res.status(400).json({ success: false, message: 'Firebase verification is missing or invalid.' });
    }

    const challenge = db.prepare('SELECT * FROM otp_challenges WHERE challenge_id = ?').get(challengeId);
    if (!challenge || challenge.channel !== 'firebase_sms' || challenge.consumed_at) {
      return res.status(400).json({ success: false, message: 'This Firebase verification is invalid or already used.' });
    }
    if (!isPurposeMethodEnabled(getConfig(), challenge.purpose, 'firebase_sms')) {
      return res.status(403).json({ success: false, message: 'Firebase SMS verification is disabled for this purpose.' });
    }
    if (Date.parse(challenge.expires_at) <= Date.now()) {
      return res.status(400).json({ success: false, message: 'This verification code has expired. Request a new one.' });
    }
    if (challenge.attempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ success: false, message: 'Too many incorrect verification attempts. Request a new code.' });
    }

    const config = getConfig();
    if (!isPurposeMethodEnabled(config, challenge.purpose, 'firebase_sms')) {
      return res.status(403).json({ success: false, message: 'Firebase SMS verification is disabled for this purpose.' });
    }
    if (!config.firebaseApiKey) {
      throw new Error('Firebase SMS is not configured. Ask the administrator to configure Firebase in Root Dashboard → OTP API.');
    }
    const firebaseResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(config.firebaseApiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
        signal: AbortSignal.timeout(10000),
      },
    );
    let firebaseResult;
    try {
      firebaseResult = await firebaseResponse.json();
    } catch {
      throw new Error('Firebase could not verify the phone session. Try again.');
    }
    const firebaseUser = firebaseResponse.ok ? firebaseResult.users?.[0] : null;
    if (!firebaseUser?.phoneNumber || normalizePhone(firebaseUser.phoneNumber) !== challenge.phone) {
      db.prepare('UPDATE otp_challenges SET attempts = attempts + 1 WHERE challenge_id = ?')
        .run(challenge.challenge_id);
      return res.status(401).json({ success: false, message: 'Firebase could not verify this phone number.' });
    }

    const data = JSON.parse(challenge.data_json || '{}');
    const isRegistration = challenge.purpose === 'registration';
    const isUpgrade = challenge.purpose === 'upgrade';
    const user = isRegistration ? null : db.prepare(`
      SELECT _id AS id, username, email, password_hash, full_name, role, permissions,
             position, phone, telegram_chat_id, is_active
      FROM users WHERE _id = ? AND is_active = 1
    `).get(data.userId);
    if (!isRegistration && !isUpgrade && (!user || normalizePhone(user.phone) !== challenge.phone)) {
      return res.status(404).json({ success: false, message: 'The account phone number changed or the account is no longer active. Request a new code.' });
    }
    const isRootRole = ['root', 'admin'].includes(String(user?.role || '').toLowerCase());
    const isRootPurpose = challenge.purpose.startsWith('root_');
    if (isRootPurpose && !isRootRole) {
      return res.status(403).json({ success: false, message: 'This phone number is not linked to a root account.' });
    }
    if (!isRootPurpose && isRootRole) {
      return res.status(403).json({ success: false, message: 'Use the Root Portal to verify this account.' });
    }
    if (['password_reset', 'root_password_reset'].includes(challenge.purpose) && String(newPassword || '').length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
    }

    const consume = db.prepare(`
      UPDATE otp_challenges SET consumed_at = datetime('now')
      WHERE challenge_id = ? AND consumed_at IS NULL AND attempts < ?
    `).run(challenge.challenge_id, MAX_OTP_ATTEMPTS);
    if (!consume.changes) {
      return res.status(400).json({ success: false, message: 'This Firebase verification is invalid or already used.' });
    }

    let result;
    if (isRegistration) {
      const contactExists = db.prepare(`SELECT 1 FROM users WHERE ${PHONE_SQL} = ?`).get(challenge.phone);
      if (contactExists) {
        return res.status(409).json({ success: false, message: 'An account already uses this phone number. Try logging in or resetting its password.' });
      }
      saveRegistrationTicket(challenge, data);
      result = { message: 'Contact verified. Complete account creation.', registrationChallengeId: challenge.challenge_id };
    } else if (isUpgrade) {
      const contactExists = db.prepare(`SELECT 1 FROM users WHERE ${PHONE_SQL} = ?`).get(challenge.phone);
      if (contactExists) {
        return res.status(409).json({ success: false, message: 'An account has already been created with this phone number.' });
      }
      const usernameBase = `user_${normalizePhone(data.phone)}`;
      let username = usernameBase;
      while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
        username = `${usernameBase}_${crypto.randomInt(1000, 10000)}`;
      }
      const insert = db.prepare(`
        INSERT INTO users (username, password_hash, full_name, role, email, phone, telegram_chat_id, is_active, created_at, created_by_role)
        VALUES (?, ?, ?, 'user', ?, ?, ?, 1, datetime('now'), 'self')
      `).run(username, data.passwordHash, data.fullName, data.email || null, data.phone || null, data.telegramChatId || null);
      const upgradedUser = db.prepare(`
        SELECT _id AS id, username, email, full_name, role, permissions, position, phone, telegram_chat_id, is_active
        FROM users WHERE _id = ?
      `).get(insert.lastInsertRowid);
      result = issueSession(upgradedUser);
    } else if (['password_reset', 'root_password_reset'].includes(challenge.purpose)) {
      const passwordHash = await bcrypt.hash(newPassword, 10);
      db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE _id = ?")
        .run(passwordHash, user.id);
      result = { message: 'Password reset successfully.' };
    } else if (challenge.purpose === 'login' || challenge.purpose === 'root_login') {
      result = issueSession(user, challenge.purpose === 'root_login');
      db.prepare("UPDATE users SET last_login = datetime('now') WHERE _id = ?").run(user.id);
    } else {
      return res.status(400).json({ success: false, message: 'This Firebase verification purpose is not supported.' });
    }
    res.json({ success: true, message: result.message || 'Verification successful.', data: result });
  } catch (error) {
    console.error('Firebase OTP verification failed:', error.message);
    responseError(res, error);
  }
};

export const requireRootOtpAccess = (req, res, next) => {
  if (!req.user || req.user.isRoot !== true) {
    return res.status(403).json({ success: false, message: 'Root access required.' });
  }
  next();
};

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
    CREATE TABLE IF NOT EXISTS telegram_registration_contacts (
      telegram_user_id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  const payload = JSON.parse(encrypted);
  const secrets = getOtpEncryptionSecrets();
  let lastError;

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
      lastError = error;
    }
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
  telegramWebhookConfigured: Boolean(config.telegramWebhookRegistered && config.telegramWebhookUrl && config.telegramWebhookSecret),
  telegramWebhookUrl: config.telegramWebhookUrl || '',
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

export const resetPasswordWithTelegramMiniApp = async (req, res) => {
  try {
    ensureSchema();
    const initData = String(req.body?.initData || '');
    const newPassword = req.body?.newPassword;
    if (!initData || initData.length > 4096 || typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 128) {
      return res.status(400).json({ success: false, message: 'Open the Telegram Mini App and enter a password of at least 6 characters.' });
    }
    const config = getConfig();
    if (!config.telegramBotToken || !isPurposeMethodEnabled(config, 'password_reset', 'telegram')) {
      return res.status(403).json({ success: false, message: 'Telegram password reset is disabled or not configured in Root Dashboard → OTP API.' });
    }
    const params = new URLSearchParams(initData);
    const entries = Array.from(params.entries());
    const hash = params.get('hash');
    if (new Set(entries.map(([key]) => key)).size !== entries.length || !/^[a-f0-9]{64}$/i.test(hash || '')) {
      return res.status(401).json({ success: false, message: 'Telegram Mini App data could not be verified. Reopen it and try again.' });
    }
    const dataCheckString = entries.filter(([key]) => key !== 'hash')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(config.telegramBotToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'))) {
      return res.status(401).json({ success: false, message: 'Telegram Mini App data could not be verified. Reopen it and try again.' });
    }
    const authDate = Number(params.get('auth_date'));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > 600) {
      return res.status(401).json({ success: false, message: 'Telegram sign-in has expired. Reopen the Mini App and try again.' });
    }
    let telegramUser;
    try {
      telegramUser = JSON.parse(params.get('user') || '');
    } catch {
      return res.status(401).json({ success: false, message: 'Telegram user data is invalid.' });
    }
    if (!Number.isSafeInteger(telegramUser?.id) || telegramUser.id <= 0) {
      return res.status(401).json({ success: false, message: 'Telegram user data is invalid.' });
    }
    const user = db.prepare(`
      SELECT _id, role FROM users
      WHERE telegram_chat_id = ? AND is_active = 1 AND lower(role) NOT IN ('root', 'admin')
    `).get(String(telegramUser.id));
    if (!user) return res.status(404).json({ success: false, message: 'No active account is linked to this Telegram account.' });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const result = db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE _id = ? AND is_active = 1")
      .run(passwordHash, user._id);
    if (!result.changes) return res.status(404).json({ success: false, message: 'Account not found. Try again.' });
    res.json({ success: true, message: 'Password reset successfully. Sign in with your new password.' });
  } catch (error) {
    console.error('Telegram Mini App password reset failed:', error.message);
    responseError(res, error);
  }
};

export const prepareTelegramMiniAppRegistration = (req, res) => {
  try {
    ensureSchema();
    getSecret();
    const initData = String(req.body?.initData || '');
    const phone = String(req.body?.phone || '').trim();
    const normalizedPhone = normalizePhone(phone);
    if (!initData || initData.length > 4096) {
      return res.status(400).json({ success: false, message: 'Open signup from the Telegram Mini App and try again.' });
    }
    if (phone && (!/^[+\d\s()-]{7,24}$/.test(phone) \vert{}\vert{} !/^\d{7,15}$/.test(normalizedPhone))) {
      return res.status(400).json({ success: false, message: 'Enter a valid phone number.' });
    }

    const config = getConfig();
    if (!config.telegramBotToken || !isPurposeMethodEnabled(config, 'registration', 'telegram')) {
      return res.status(403).json({ success: false, message: 'Telegram Mini App signup is not enabled in Root Dashboard → OTP API.' });
    }
    if (phone && !safeConfig(config).telegramWebhookConfigured) {
      return res.status(503).json({ success: false, message: 'Telegram phone sharing is not configured. Ask an administrator to configure the Telegram webhook in Root Dashboard → OTP API.' });
    }
    const params = new URLSearchParams(initData);
    const entries = Array.from(params.entries());
    const hash = params.get('hash');
    if (new Set(entries.map(([key]) => key)).size !== entries.length || !/^[a-f0-9]{64}$/i.test(hash || '')) {
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

    const telegramUserIdStr = String(telegramUser.id);
    const existingUser = db.prepare('SELECT 1 FROM users WHERE telegram_chat_id = ? AND is_active = 1').get(telegramUserIdStr);
    if (existingUser) {
      return res.status(409).json({ success: false, message: 'This Telegram account is already linked to an existing user. Sign in instead.' });
    }

    if (phone) {
      const existingPhone = db.prepare(`SELECT 1 FROM users WHERE ${PHONE_SQL} = ? AND is_active = 1`).get(normalizedPhone);
      if (existingPhone) {
        return res.status(409).json({ success: false, message: 'An active account with this phone number already exists.' });
      }
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      db.prepare(`
        INSERT INTO telegram_registration_contacts (telegram_user_id, phone, expires_at)
        VALUES (?, ?, ?)
        ON CONFLICT(telegram_user_id) DO UPDATE SET phone = excluded.phone, expires_at = excluded.expires_at, created_at = CURRENT_TIMESTAMP
      `).run(telegramUserIdStr, normalizedPhone, expiresAt);
    }

    res.json({ success: true, message: 'Telegram verification prepared successfully.' });
  } catch (error) {
    console.error('Telegram Mini App registration preparation failed:', error.message);
    responseError(res, error);
  }
};

export const registerInTelegramMiniApp = async (req, res) => {
  try {
    ensureSchema();
    const initData = String(req.body?.initData || '');
    const password = req.body?.password;
    if (!initData || initData.length > 4096 || typeof password !== 'string' || password.length < 6 || password.length > 128) {
      return res.status(400).json({ success: false, message: 'Open the Telegram Mini App and enter a password of at least 6 characters.' });
    }
    const config = getConfig();
    if (!config.telegramBotToken || !isPurposeMethodEnabled(config, 'registration', 'telegram')) {
      return res.status(403).json({ success: false, message: 'Telegram Mini App signup is not enabled in Root Dashboard → OTP API.' });
    }
    const params = new URLSearchParams(initData);
    const entries = Array.from(params.entries());
    const hash = params.get('hash');
    if (new Set(entries.map(([key]) => key)).size !== entries.length || !/^[a-f0-9]{64}$/i.test(hash || '')) {
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

    const telegramUserIdStr = String(telegramUser.id);
    const existingUser = db.prepare('SELECT 1 FROM users WHERE telegram_chat_id = ? AND is_active = 1').get(telegramUserIdStr);
    if (existingUser) {
      return res.status(409).json({ success: false, message: 'This Telegram account is already linked to an existing user. Sign in instead.' });
    }

    const fullName = `${telegramUser.first_name || ''} ${telegramUser.last_name || ''}`.trim() || 'Telegram User';
    const username = telegramUser.username || `user_${telegramUser.id}`;
    const passwordHash = await bcrypt.hash(password, 10);

    const result = db.prepare(`
      INSERT INTO users (username, full_name, password_hash, telegram_chat_id, role, is_active, created_at)
      VALUES (?, ?, ?, ?, 'user', 1, datetime('now'))
    `).run(username, fullName, passwordHash, telegramUserIdStr);

    const newUser = db.prepare('SELECT _id AS id, username, email, full_name, role, permissions, position, phone, telegram_chat_id, is_active FROM users WHERE _id = ?').get(result.lastInsertRowid);
    const session = issueSession(newUser);
    res.json({ success: true, message: 'Account created successfully via Telegram Mini App.', data: session });
  } catch (error) {
    console.error('Telegram Mini App registration failed:', error.message);
    responseError(res, error);
  }
};
