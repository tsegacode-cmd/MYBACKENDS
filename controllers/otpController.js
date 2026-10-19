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
    const saved = config?.telegramWidgetMethods?.[purpose];
    if (typeof saved === 'boolean') methods[purpose] = saved;
  }
  return methods;
};

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
      const saved = config?.purposeMethods?.[purpose]?.[channel];
      if (typeof saved === 'boolean') {
        methods[purpose][channel] = saved;
      }
    }
  }
  return methods;
};

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
    CREATE TABLE IF NOT EXISTS registration_otp_tickets (
      challenge_id TEXT PRIMARY KEY,
      contact_type TEXT NOT NULL,
      contact TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
