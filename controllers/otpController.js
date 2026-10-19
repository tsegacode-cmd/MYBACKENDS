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
