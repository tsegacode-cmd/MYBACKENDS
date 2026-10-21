import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '../database_files/redsea_brokerage.db'));
const DEFAULT_SITE_CONTENT = {
  headerTitle: 'REDSEA',
  headerTagline: 'Your trusted partner in commission work and brokerage services',
  loadingScreenTitle: 'REDSEA',
  installAppButtonText: 'Install REDSEA App',
  footerBrandTitle: 'REDSEA',
  footerDescription: 'Your trusted partner in commission work and brokerage services',
  servicesTitle: 'Services',
  services: ['Fixed Commission', 'Movable Commission', 'Brokerage Services'],
  contactTitle: 'Contact',
  contactPageTitle: 'Contact Us',
  contactPageSubtitle: 'Get in touch with our team',
  contactIntroTitle: 'Get In Touch',
  contactIntroText: "Have questions about our services? Want to discuss a potential partnership? We're here to help. Reach out to us using the contact form or through any of the methods below.",
  contactOfficeTitle: '📍 Office Location',
  contactOfficeDetails: '123 Business District\nRed Sea Plaza, Suite 500\nCity, State 12345',
  contactPhoneTitle: '📞 Phone',
  contactPhoneDetails: 'Main: +1 (555) 123-4567\nFax: +1 (555) 123-4568',
  contactEmailTitle: '📧 Email',
  contactEmailDetails: 'General: info@redsea.com\nSupport: support@redsea.com\nSales: sales@redsea.com',
  contactHoursTitle: '🕐 Business Hours',
  contactHoursDetails: 'Monday - Friday: 9:00 AM - 6:00 PM\nSaturday: 10:00 AM - 4:00 PM\nSunday: Closed',
  contactFormTitle: 'Send Us a Message',
  contactServiceOptions: ['Fixed Commission', 'Movable Commission', 'Brokerage Services', 'General Inquiry'],
  contactSendButtonText: 'Send Message',
  contactAboutTitle: 'About REDSEA',
  contactAboutParagraphOne: 'REDSEA is a leading platform for commission work and brokerage services. We specialize in connecting businesses and individuals through our comprehensive fixed commission, movable commission, and brokerage service offerings.',
  contactAboutParagraphTwo: 'With years of experience in the industry, our team is dedicated to providing transparent, efficient, and professional services that help our clients achieve their business goals. Whether you are looking for stable fixed commission structures, performance-based movable commissions, or expert brokerage services, REDSEA is your trusted partner.',
  email: 'info@redsea.com',
  phone: '+1 (555) 123-4567',
  copyrightText: 'All rights reserved. Commission Work & Brokerage Services fixed and movable.',
  termsAndConditions: 'Welcome to REDSEA.\n\nUse the platform respectfully and provide accurate information. Rewards, promotions, and claim-game settings are managed by REDSEA and may change over time. Do not use multiple accounts, automated tools, or other methods to manipulate rewards.\n\nETB rewards are credited according to the applicable reward rules. Coin rewards are separate from ETB wallet balances. Daily Claim games have per-game limits and rolling 24-hour cooldowns. Review the reward and cooldown shown in the app before playing.\n\nBookings, payment requests, products, and services are subject to availability and the payment terms shown at checkout. Optional delivery fees are separate from booking payments and are due on receipt when delivery is requested.\n\nBy using REDSEA, you agree to follow these terms and applicable laws. Contact REDSEA support if you have a question about your account or a reward.',
  accountAccessSettings: {
    enabled: true,
    rules: [
      { role: 'guest', label: 'Guest', enabled: true, hiddenMenus: ['data-collect'], hiddenRoutes: [], notes: '' },
      { role: 'user', label: 'User', enabled: true, hiddenMenus: ['data-collect'], hiddenRoutes: [], notes: '' },
      { role: 'staff', label: 'Staff', enabled: true, hiddenMenus: [], hiddenRoutes: [], notes: '' },
      { role: 'manager', label: 'Manager', enabled: true, hiddenMenus: [], hiddenRoutes: [], notes: '' },
      { role: 'agent', label: 'Agent', enabled: true, hiddenMenus: [], hiddenRoutes: [], notes: '' },
      { role: 'admin', label: 'Admin', enabled: true, hiddenMenus: [], hiddenRoutes: [], notes: '' },
      { role: 'root', label: 'Root Admin', enabled: true, hiddenMenus: [], hiddenRoutes: [], notes: '' },
    ]
  }
};
const FIELD_LIMITS = {
  headerTitle: 100,
  headerTagline: 500,
  footerBrandTitle: 100,
  footerDescription: 500,
  servicesTitle: 100,
  contactTitle: 100,
  email: 254,
  phone: 80,
  copyrightText: 500,
};
const CONTACT_FIELD_LIMITS = {
  contactPageTitle: 120,
  contactPageSubtitle: 500,
  contactIntroTitle: 120,
  contactIntroText: 2000,
  contactOfficeTitle: 120,
  contactOfficeDetails: 1000,
  contactPhoneTitle: 120,
  contactPhoneDetails: 1000,
  contactEmailTitle: 120,
  contactEmailDetails: 1000,
  contactHoursTitle: 120,
  contactHoursDetails: 1000,
  contactFormTitle: 120,
  contactSendButtonText: 80,
  contactAboutTitle: 120,
  contactAboutParagraphOne: 3000,
  contactAboutParagraphTwo: 3000,
};
const OPTIONAL_FIELD_LIMITS = {
  loadingScreenTitle: 100,
  installAppButtonText: 100,
  termsAndConditions: 20000,
};

const normalizeAccountAccessSettings = (settings = {}) => {
  const rules = Array.isArray(settings.rules) ? settings.rules : [];
  return {
    enabled: settings.enabled !== false,
    rules: rules
      .map((rule, index) => {
        const role = String(rule?.role || `role_${index + 1}`).trim().toLowerCase();
        const label = String(rule?.label || role || `Role ${index + 1}`).trim();
        const hiddenMenus = Array.isArray(rule?.hiddenMenus)
          ? rule.hiddenMenus
              .filter(value => typeof value === 'string')
              .map(value => value.trim())
              .filter(Boolean)
          : [];
        const hiddenRoutes = Array.isArray(rule?.hiddenRoutes)
          ? rule.hiddenRoutes
              .filter(value => typeof value === 'string')
              .map(value => value.trim().replace(/^\/+/, '').replace(/\/+$/, ''))
              .filter(Boolean)
          : [];
        return {
          role,
          label: label || role,
          enabled: rule?.enabled !== false,
          hiddenMenus,
          hiddenRoutes,
          notes: typeof rule?.notes === 'string' ? rule.notes.slice(0, 500) : ''
        };
      })
      .filter(rule => rule.role)
  }
};

const ensureSchema = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_content_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      content_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
};

const readSiteContent = () => {
  ensureSchema();
  const row = db.prepare('SELECT content_json FROM site_content_settings WHERE id = 1').get();
  return row ? { ...DEFAULT_SITE_CONTENT, ...JSON.parse(row.content_json) } : DEFAULT_SITE_CONTENT;
};

export const getSiteContent = (req, res) => {
  try {
    res.json({ success: true, data: readSiteContent() });
  } catch (error) {
    console.error('Could not read website content:', error);
    res.status(500).json({ success: false, message: 'Could not load website content.' });
  }
};

export const saveSiteContent = (req, res) => {
  try {
    const existingContent = readSiteContent();
    const content = {};
    for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
      const value = req.body[field];
      if (typeof value !== 'string' || value.trim().length > limit) {
        return res.status(400).json({
          success: false,
          message: `${field} must be text no longer than ${limit} characters.`,
        });
      }
      content[field] = value.trim();
    }

    for (const [field, limit] of Object.entries(OPTIONAL_FIELD_LIMITS)) {
      const value = req.body[field] ?? existingContent[field] ?? DEFAULT_SITE_CONTENT[field];
      if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) {
        return res.status(400).json({
          success: false,
          message: `${field} must be text between 1 and ${limit} characters.`,
        });
      }
      content[field] = value.trim();
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(content.email)) {
      return res.status(400).json({ success: false, message: 'Enter a valid contact email address.' });
    }
    if (!Array.isArray(req.body.services) || req.body.services.length > 20) {
      return res.status(400).json({ success: false, message: 'Services must be a list of no more than 20 items.' });
    }
    if (req.body.services.some(service =>
      typeof service !== 'string' || service.trim().length === 0 || service.trim().length > 100
    )) {
      return res.status(400).json({ success: false, message: 'Each service must contain 1–100 characters.' });
    }
    content.services = req.body.services.map(service => service.trim());
    for (const [field, limit] of Object.entries(CONTACT_FIELD_LIMITS)) {
      const value = req.body[field] ?? existingContent[field] ?? DEFAULT_SITE_CONTENT[field];
      if (typeof value !== 'string' || value.trim().length > limit) {
        return res.status(400).json({ success: false, message: `${field} must be text no longer than ${limit} characters.` });
      }
      content[field] = value.trim();
    }
    const contactServiceOptions = req.body.contactServiceOptions ?? existingContent.contactServiceOptions ?? DEFAULT_SITE_CONTENT.contactServiceOptions;
    if (!Array.isArray(contactServiceOptions) || contactServiceOptions.length > 20 ||
      contactServiceOptions.some(option => typeof option !== 'string' || !option.trim() || option.trim().length > 100)) {
      return res.status(400).json({ success: false, message: 'Contact service options must contain up to 20 non-empty labels of no more than 100 characters.' });
    }
    content.contactServiceOptions = contactServiceOptions.map(option => option.trim());
    content.accountAccessSettings = normalizeAccountAccessSettings(req.body.accountAccessSettings);

    ensureSchema();
    db.prepare(`
      INSERT INTO site_content_settings (id, content_json, updated_at)
      VALUES (1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        content_json = excluded.content_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(JSON.stringify(content));
    res.json({ success: true, data: content });
  } catch (error) {
    console.error('Could not save website content:', error);
    res.status(500).json({ success: false, message: 'Could not save website content.' });
  }
};
