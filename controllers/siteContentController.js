import { queryNeon } from '../config/neonDatabase.js';
const DEFAULT_SITE_CONTENT = {
  maintenanceEnabled: false,
  maintenanceMessage: 'We are performing scheduled maintenance. Please check back soon.',
  headerTitle: 'REDSEA',
  headerTagline: 'Your trusted partner in commission work and brokerage services',
  homePromotionsEyebrow: 'REDSEA OFFERS',
  homePromotionsTitle: 'Promotions',
  homePromotionsDescription: 'Featured updates and deals from our team',
  homeShowPromotionText: 'Show promotion',
  homeCoinBadge: 'VIRTUAL REWARDS',
  homeCoinTitle: 'Introducing RedSeaPro Coin',
  homeCoinDescription: 'Earn and use RedSeaPro Coins across the virtual rewards program.',
  homeCoinButtonText: 'Explore your wallet',
  homeCoinAriaLabel: 'Explore your RedSeaPro Coin virtual rewards in your wallet',
  homeCatalogEyebrow: 'DISCOVER REDSEA',
  homeCatalogTitle: 'Services & Products',
  homeCatalogDescription: 'Browse published listings across every service category.',
  homeSearchLabel: 'Search all services and products',
  homeSearchPlaceholder: 'Search listings, locations, providers...',
  homeClearSearchLabel: 'Clear search',
  homeFilterLabel: 'Filter products by category',
  homeAllCategoriesLabel: 'All',
  homeEmptyMessage: 'New products and services will appear here as they are published.',
  homeFeaturedTitle: 'Popular & sponsored',
  homeCommunityLinkText: 'See the community feed',
  homeSponsoredBadgeText: 'Sponsored',
  homeBoostedBadgeText: 'Boosted',
  homePinnedAlertText: 'Pinned alert',
  homeViewProductText: 'View product',
  homeNoResultsPrefix: 'No services or products match',
  homeCategoryTitles: {
    'broker-house': 'Broker & House',
    'create-partnership': 'Brokerage',
    'room-booking': 'Room Booking',
    logistics: 'Logistics',
    'movable-services': 'Big Service',
  },
  homeViewCategoryText: 'View category',
  footerEmailPrefix: 'Email',
  footerPhonePrefix: 'Phone',
  footerContactSupportText: 'Contact support',
  footerWhatsAppSupportText: 'WhatsApp support',
  footerTermsButtonText: 'Terms & Conditions',
  footerTermsTitle: 'Terms & Conditions',
  footerTermsUnavailableText: 'Terms and conditions are not available.',
  footerTermsCloseText: 'Close',
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
  copyrightYear: '2024',
  copyrightText: 'All rights reserved. Commission Work & Brokerage Services fixed and movable.',
  termsAndConditions: 'Welcome to REDSEA.\n\nUse the platform respectfully and provide accurate information. Rewards, promotions, and claim-game settings are managed by REDSEA and may change over time. Do not use multiple accounts, automated tools, or other methods to manipulate rewards.\n\nETB rewards are credited according to the applicable reward rules. Coin rewards are separate from ETB wallet balances. Daily Claim games have per-game limits and rolling 24-hour cooldowns. Review the reward and cooldown shown in the app before playing.\n\nBookings, payment requests, products, and services are subject to availability and the payment terms shown at checkout. Optional delivery fees are separate from booking payments and are due on receipt when delivery is requested.\n\nBy using REDSEA, you agree to follow these terms and applicable laws. Contact REDSEA support if you have a question about your account or a reward.',
  accountAccessSettings: {
    enabled: true,
    rules: [
      { role: 'visitor', label: 'Not logged in', enabled: true, hiddenMenus: [], hiddenRoutes: [], actions: { deleteRegistrations: false }, notes: '' },
      { role: 'guest', label: 'Guest', enabled: true, hiddenMenus: ['data-collect'], hiddenRoutes: [], actions: { deleteRegistrations: false }, notes: '' },
      { role: 'user', label: 'User', enabled: true, hiddenMenus: ['data-collect'], hiddenRoutes: [], actions: { deleteRegistrations: false }, notes: '' },
      { role: 'staff', label: 'Staff', enabled: true, hiddenMenus: [], hiddenRoutes: [], actions: { deleteRegistrations: false }, notes: '' },
      { role: 'manager', label: 'Manager', enabled: true, hiddenMenus: [], hiddenRoutes: [], actions: { deleteRegistrations: false }, notes: '' },
      { role: 'agent', label: 'Agent', enabled: true, hiddenMenus: [], hiddenRoutes: [], actions: { deleteRegistrations: false }, notes: '' },
      { role: 'driver', label: 'Driver', enabled: true, hiddenMenus: [], hiddenRoutes: [], actions: { deleteRegistrations: false }, notes: '' },
      { role: 'admin', label: 'Admin', enabled: true, hiddenMenus: [], hiddenRoutes: [], actions: { deleteRegistrations: true }, notes: '' },
      { role: 'root', label: 'Root Admin', enabled: true, hiddenMenus: [], hiddenRoutes: [], actions: { deleteRegistrations: true }, notes: '' },
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
  homePromotionsEyebrow: 100,
  homePromotionsTitle: 120,
  homePromotionsDescription: 500,
  homeShowPromotionText: 100,
  homeCoinBadge: 80,
  homeCoinTitle: 120,
  homeCoinDescription: 500,
  homeCoinButtonText: 100,
  homeCoinAriaLabel: 200,
  homeCatalogEyebrow: 100,
  homeCatalogTitle: 120,
  homeCatalogDescription: 500,
  homeSearchLabel: 120,
  homeSearchPlaceholder: 200,
  homeClearSearchLabel: 100,
  homeFilterLabel: 120,
  homeAllCategoriesLabel: 80,
  homeEmptyMessage: 500,
  homeFeaturedTitle: 120,
  homeCommunityLinkText: 120,
  homeSponsoredBadgeText: 80,
  homeBoostedBadgeText: 80,
  homePinnedAlertText: 100,
  homeViewProductText: 100,
  homeNoResultsPrefix: 150,
  homeViewCategoryText: 100,
  footerEmailPrefix: 40,
  footerPhonePrefix: 40,
  footerContactSupportText: 100,
  footerWhatsAppSupportText: 100,
  footerTermsButtonText: 100,
  footerTermsTitle: 120,
  footerTermsUnavailableText: 200,
  footerTermsCloseText: 80,
  loadingScreenTitle: 100,
  installAppButtonText: 100,
  termsAndConditions: 20000,
  maintenanceMessage: 1000,
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
          actions: {
            deleteRegistrations: typeof rule?.actions?.deleteRegistrations === 'boolean'
              ? rule.actions.deleteRegistrations
              : ['admin', 'root'].includes(role),
          },
          notes: typeof rule?.notes === 'string' ? rule.notes.slice(0, 500) : ''
        };
      })
      .filter(rule => rule.role)
  }
};

const readSiteContent = async () => {
  await queryNeon(`
    CREATE TABLE IF NOT EXISTS site_content_settings (
      id BIGINT PRIMARY KEY CHECK (id = 1),
      content_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    )
  `);
  const { rows } = await queryNeon('SELECT content_json FROM site_content_settings WHERE id = 1');
  const row = rows[0];
  return row ? { ...DEFAULT_SITE_CONTENT, ...JSON.parse(row.content_json) } : DEFAULT_SITE_CONTENT;
};

export const getSiteContent = async (req, res) => {
  try {
    res.json({ success: true, data: await readSiteContent() });
  } catch (error) {
    console.error('Could not read website content:', error);
    res.status(500).json({ success: false, message: 'Could not load website content.' });
  }
};

export const saveSiteContent = async (req, res) => {
  try {
    const existingContent = await readSiteContent();
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

    const copyrightYear = req.body.copyrightYear ?? existingContent.copyrightYear ?? DEFAULT_SITE_CONTENT.copyrightYear;
    if (typeof copyrightYear !== 'string' || !/^\d{4}$/.test(copyrightYear)) {
      return res.status(400).json({ success: false, message: 'copyrightYear must be a four-digit year.' });
    }
    content.copyrightYear = copyrightYear;

    const homeCategoryTitles = req.body.homeCategoryTitles ?? existingContent.homeCategoryTitles ?? DEFAULT_SITE_CONTENT.homeCategoryTitles;
    if (!homeCategoryTitles || typeof homeCategoryTitles !== 'object' || Array.isArray(homeCategoryTitles)) {
      return res.status(400).json({ success: false, message: 'homeCategoryTitles must be an object of category labels.' });
    }
    content.homeCategoryTitles = {};
    for (const [key, defaultTitle] of Object.entries(DEFAULT_SITE_CONTENT.homeCategoryTitles)) {
      const title = homeCategoryTitles[key] ?? defaultTitle;
      if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) {
        return res.status(400).json({ success: false, message: `Home category title ${key} must contain 1–120 characters.` });
      }
      content.homeCategoryTitles[key] = title.trim();
    }

    for (const [field, limit] of Object.entries(OPTIONAL_FIELD_LIMITS)) {
      const value = req.body[field] ?? existingContent[field] ?? DEFAULT_SITE_CONTENT[field];
      if (typeof value !== 'string' || (field !== 'maintenanceMessage' && !value.trim()) || value.trim().length > limit) {
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
    if (req.body.maintenanceEnabled !== undefined && typeof req.body.maintenanceEnabled !== 'boolean') {
      return res.status(400).json({ success: false, message: 'maintenanceEnabled must be a boolean.' });
    }
    content.maintenanceEnabled = req.body.maintenanceEnabled ?? existingContent.maintenanceEnabled ?? false;

    await queryNeon(`
      INSERT INTO site_content_settings (id, content_json, updated_at)
      VALUES (1, ?, CURRENT_TIMESTAMP::text)
      ON CONFLICT(id) DO UPDATE SET
        content_json = excluded.content_json,
        updated_at = CURRENT_TIMESTAMP::text
    `, [JSON.stringify(content)]);
    res.json({ success: true, data: content });
  } catch (error) {
    console.error('Could not save website content:', error);
    res.status(500).json({ success: false, message: 'Could not save website content.' });
  }
};
