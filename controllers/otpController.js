import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { queryNeon } from '../config/neonDatabase.js';
import { awardDailyLoginCoins, ensureReferralCode, registerReferredUser } from '../controllers/socialController.js';

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

const ensureSchema = async () => {
  await queryNeon(`
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
      user_id BIGINT NOT NULL,
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
};

const getSecret = () => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be configured before OTP authentication can be used.');
  }
  return process.env.JWT_SECRET;
};

const getOtpEncryptionSecrets = () => {
  const secrets = [
    process.env.OTP_ENCRYPTION_KEY,
    process.env.JWT_SECRET,
    process.env.OTP_ENCRYPTION_KEY_PREVIOUS,
  ].filter(Boolean);
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

const getConfig = async () => {
  await ensureSchema();
  const { rows } = await queryNeon('SELECT encrypted_config FROM otp_settings WHERE id = 1');
  const row = rows[0];
  if (!row) return {};

  try {
    const { config, needsReEncryption } = decryptConfig(row.encrypted_config);
    if (needsReEncryption) {
      await queryNeon(`
        UPDATE otp_settings
        SET encrypted_config = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `, [encryptConfig(config)]);
    }
    return config;
  } catch (error) {
    console.error('Resetting incompatible OTP settings due to secret change:', error.message);
    await queryNeon('DELETE FROM otp_settings WHERE id = 1');
    return {};
  }
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

const findUserByPhone = async (phone) => {
  const { rows } = await queryNeon(`
    SELECT _id AS id, username, email, password_hash, full_name, role, permissions,
           position, phone, telegram_chat_id, is_active
    FROM users WHERE ${PHONE_SQL} = ? AND is_active = 1
  `, [normalizePhone(phone)]);
  return rows[0];
};

const findUserByEmail = async (email) => {
  const { rows } = await queryNeon(`
    SELECT _id AS id, username, email, password_hash, full_name, role, permissions,
           position, phone, telegram_chat_id, is_active
    FROM users WHERE lower(trim(email)) = ? AND is_active = 1
  `, [normalizeEmail(email)]);
  return rows[0];
};

const hashCode = (challengeId, code) =>
  crypto.createHmac('sha256', getSecret()).update(`${challengeId}:${code}`).digest('hex');

const saveRegistrationTicket = async (challenge, data) => {
  const contact = data.contactType === 'email'
    ? data.email
    : data.contactType === 'telegram' ? data.telegramChatId : normalizePhone(data.phone);
  await queryNeon(`
    INSERT INTO registration_otp_tickets (challenge_id, contact_type, contact, phone)
    VALUES (?, ?, ?, ?)
  `, [challenge.challenge_id, data.contactType, contact, normalizePhone(data.phone)]);
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
    const config = await getConfig();
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
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getTelegramLinkStatus = async (req, res) => {
  try {
    await ensureSchema();
    const { rows } = await queryNeon('SELECT telegram_chat_id FROM users WHERE _id = ? AND is_active = 1', [req.user.id]);
    const user = rows[0];
    if (!user) {
      return res.status(404).json({ success: false, message: 'The account is no longer active.' });
    }
    res.json({ success: true, data: { linked: Boolean(user.telegram_chat_id) } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const startTelegramLink = async (req, res) => {
  try {
    await ensureSchema();
    getSecret();
    const chatId = String(req.body.chatId || '').trim();
    if (!/^[1-9]\d{0,18}$/.test(chatId)) {
      return res.status(400).json({ success: false, message: 'Enter a valid private Telegram chat ID.' });
    }

    const { rows } = await queryNeon('SELECT _id FROM users WHERE _id = ? AND is_active = 1', [req.user.id]);
    const user = rows[0];
    if (!user) {
      return res.status(404).json({ success: false, message: 'The account is no longer active.' });
    }

    const requestIp = String(req.ip || req.socket.remoteAddress || '').slice(0, 80);
    const { rows: countRows } = await queryNeon(`
      SELECT COUNT(*) AS count FROM telegram_link_challenges
      WHERE user_id = ? AND created_at >= NOW() - INTERVAL '15 minutes'
    `, [req.user.id]);
    const recentCount = Number(countRows[0]?.count || 0);
    if (recentCount >= 3) {
      return res.status(429).json({ success: false, message: 'Too many Telegram link requests. Wait 15 minutes and try again.' });
    }

    const config = await getConfig();
    const code = String(crypto.randomInt(100000, 1000000));
    const challengeId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + OTP_LIFETIME_MINUTES * 60 * 1000).toISOString();

    await sendTelegram(
      config,
      chatId,
      code,
      `Your REDSEA Telegram linking code is ${code}. It expires in ${OTP_LIFETIME_MINUTES} minutes.`
    );

    await queryNeon(`
      UPDATE telegram_link_challenges SET consumed_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND consumed_at IS NULL
    `, [req.user.id]);
    
    await queryNeon(`
      INSERT INTO telegram_link_challenges (challenge_id, user_id, chat_id, request_ip, code_hash, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [challengeId, req.user.id, chatId, requestIp, hashCode(challengeId, code), expiresAt]);

    res.json({
      success: true,
      message: 'A verification code was sent to that Telegram chat.',
      data: { challengeId, expiresAt },
    });
  } catch (error) {
    console.error('Telegram account linking failed:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const verifyTelegramLink = async (req, res) => {
  try {
    await ensureSchema();
    getSecret();
    const { challengeId, code: rawCode } = req.body;
    const code = String(rawCode || '').trim();
    
    const { rows } = await queryNeon(`
      SELECT * FROM telegram_link_challenges
      WHERE challenge_id = ? AND user_id = ?
    `, [challengeId, req.user.id]);
    const challenge = rows[0];
    
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
      await queryNeon('UPDATE telegram_link_challenges SET attempts = attempts + 1 WHERE challenge_id = ?', [challenge.challenge_id]);
      return res.status(400).json({ success: false, message: 'The Telegram linking code is incorrect.' });
    }

    const { rows: linkedRows } = await queryNeon('SELECT 1 FROM users WHERE telegram_chat_id = ? AND _id != ?', [challenge.chat_id, req.user.id]);
    if (linkedRows.length > 0) {
      return res.status(409).json({ success: false, message: 'This Telegram chat is already linked to another account.' });
    }

    const updateRes = await queryNeon("UPDATE users SET telegram_chat_id = ?, updated_at = CURRENT_TIMESTAMP WHERE _id = ? AND is_active = 1", [challenge.chat_id, req.user.id]);
    if (updateRes.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'The account is no longer active.' });
    }
    await queryNeon("UPDATE telegram_link_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE challenge_id = ?", [challenge.challenge_id]);
    res.json({ success: true, message: 'Telegram chat linked. Telegram OTP login is now available.' });
  } catch (error) {
    console.error('Telegram account linking verification failed:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const telegramMiniAppLogin = async (req, res) => {
  try {
    await ensureSchema();
    getSecret();

    const initData = String(req.body.initData || '');
    if (!initData || initData.length > 4096) {
      return res.status(400).json({ success: false, message: 'Telegram Mini App data is missing or invalid.' });
    }

    const config = await getConfig();
    if (!config.telegramBotToken) {
      return res.status(503).json({ success: false, message: 'Telegram Mini App sign-in is not configured.' });
    }
    if (!isPurposeMethodEnabled(config, 'login', 'telegram')) {
      return res.status(403).json({ success: false, message: 'Telegram sign-in is disabled.' });
    }

    const entries = Array.from(new URLSearchParams(initData).entries());
    const keys = entries.map(([key]) => key);
    const hash = new URLSearchParams(initData).get('hash');
    if (new Set(keys).size !== keys.length || !/^[a-f0-9]{64}$/i.test(hash || '')) {
      return res.status(401).json({ success: false, message: 'Telegram Mini App data could not be verified.' });
    }

    const dataCheckString = entries
      .filter(([key]) => key !== 'hash')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(config.telegramBotToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'))) {
      return res.status(401).json({ success: false, message: 'Telegram Mini App data verification failed.' });
    }

    const params = new URLSearchParams(initData);
    const authDate = Number(params.get('auth_date'));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > 86400) {
      return res.status(401).json({ success: false, message: 'Telegram Mini App data has expired.' });
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

    const { rows } = await queryNeon(`
      SELECT _id AS id, username, email, full_name, role, permissions, position, phone,
             telegram_chat_id, is_active
      FROM users WHERE telegram_chat_id = ? AND is_active = 1
    `, [String(telegramUser.id)]);
    const user = rows[0];
    if (!user) {
      return res.status(403).json({ success: false, message: 'No active account is linked to this Telegram account.' });
    }
    if (['root', 'admin'].includes(String(user.role || '').toLowerCase())) {
      return res.status(403).json({ success: false, message: 'Root accounts must sign in through the Root Portal.' });
    }

    await queryNeon("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE _id = ?", [user.id]);
    
    // Generate JWT token session
    const token = jwt.sign(
      { id: user.id, email: user.email, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    delete user.password_hash;

    res.json({ success: true, message: 'Telegram Mini App login successful.', data: { user, token } });
  } catch (error) {
    console.error('Telegram Mini App login failed:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};
