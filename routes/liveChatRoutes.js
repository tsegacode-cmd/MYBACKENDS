import express from 'express';
import { getRawSQLiteDB } from '../config/databaseManager.js';
import { authenticate, authenticateOptional, authorize } from '../middleware/auth.js';
import { requireRootOtpAccess } from '../controllers/otpController.js';

const router = express.Router();
const conversationIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const messageTypes = new Set([
  'text',
  'attachment',
  'voice',
  'call-offer',
  'call-answer',
  'call-end',
  'call-record-request',
  'call-record-consent',
  'call-record-decline',
]);
const maxAttachmentCharacters = 9 * 1024 * 1024;

const isValidConversationId = value =>
  typeof value === 'string' && conversationIdPattern.test(value);

const getConversation = conversationId => getRawSQLiteDB().prepare(`
  SELECT conversation_id AS conversationId, participant_type AS participantType,
         participant_id AS participantId, device_id AS deviceId, account_id AS accountId,
         display_name AS displayName
  FROM live_chat_conversations
  WHERE conversation_id = ?
`).get(conversationId);

const authorizeClientConversation = (req, res, conversationId, deviceId) => {
  if (typeof deviceId !== 'string' || !isValidConversationId(deviceId)) {
    res.status(400).json({ success: false, message: 'A valid device ID is required.' });
    return false;
  }

  const conversation = getConversation(conversationId);
  if (!conversation) {
    res.status(404).json({ success: false, message: 'Chat session not found. Reopen live support to reconnect.' });
    return false;
  }

  const accountId = req.user?.id === undefined ? null : String(req.user.id);
  if (conversation.deviceId !== deviceId || conversation.accountId !== accountId) {
    res.status(403).json({ success: false, message: 'This chat belongs to another account or device.' });
    return false;
  }
  return true;
};

const getMessages = (conversationId, after = 0) => getRawSQLiteDB().prepare(`
  SELECT messages._id AS id, messages.conversation_id AS conversationId,
         messages.sender, COALESCE(messages.sender_name,
           CASE WHEN messages.sender = 'client' THEN conversations.display_name ELSE 'Support' END
         ) AS senderName,
         messages.type, messages.text,
         messages.attachment_name AS attachmentName, messages.attachment_mime AS attachmentMime,
         messages.created_at AS createdAt
  FROM live_chat_messages messages
  LEFT JOIN live_chat_conversations conversations
    ON conversations.conversation_id = messages.conversation_id
  WHERE messages.conversation_id = ? AND messages._id > ?
  ORDER BY messages._id ASC
  LIMIT 100
`).all(conversationId, after);

const saveMessage = (conversationId, sender, senderName, body, res) => {
  const payload = body && typeof body === 'object' ? body : {};
  const type = payload.type === undefined ? 'text' : payload.type;
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const attachment = payload.attachment;

  if (typeof type !== 'string') {
    return res.status(400).json({ success: false, message: 'A valid message is required.' });
  }
  const maxTextLength = type === 'text' ? 4000 : type.startsWith('call-') ? 128 * 1024 : 0;
  if (!messageTypes.has(type) || (type === 'text' && !text) || text.length > maxTextLength) {
    return res.status(400).json({ success: false, message: 'A valid message is required.' });
  }

  if (type === 'attachment' || type === 'voice') {
    if (
      !attachment ||
      typeof attachment.name !== 'string' ||
      attachment.name.length > 255 ||
      /[\r\n\0]/.test(attachment.name) ||
      typeof attachment.mime !== 'string' ||
      !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(attachment.mime) ||
      typeof attachment.data !== 'string' ||
      !new RegExp(`^data:${attachment.mime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')};base64,[A-Za-z0-9+/]*={0,2}$`).test(attachment.data) ||
      attachment.data.length > maxAttachmentCharacters
    ) {
      return res.status(400).json({ success: false, message: 'The attachment is invalid or too large (maximum 6 MB).' });
    }
  }

  const result = getRawSQLiteDB().prepare(`
    INSERT INTO live_chat_messages
      (conversation_id, sender, sender_name, type, text, attachment_name, attachment_mime, attachment_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    conversationId,
    sender,
    senderName,
    type,
    text,
    attachment?.name || null,
    attachment?.mime || null,
    attachment?.data || null
  );

  const message = getRawSQLiteDB().prepare(`
    SELECT _id AS id, conversation_id AS conversationId, sender, sender_name AS senderName, type, text,
           attachment_name AS attachmentName, attachment_mime AS attachmentMime,
           created_at AS createdAt
    FROM live_chat_messages WHERE _id = ?
  `).get(result.lastInsertRowid);
  return res.status(201).json({ success: true, data: message });
};

router.post('/conversations/:conversationId/register', authenticateOptional, (req, res) => {
  const { conversationId } = req.params;
  const { deviceId } = req.body || {};
  if (!isValidConversationId(conversationId) || !isValidConversationId(deviceId)) {
    return res.status(400).json({ success: false, message: 'Invalid chat session or device ID.' });
  }

  const db = getRawSQLiteDB();
  let participant;
  if (req.user?.id !== undefined) {
    const userId = String(req.user.id);
    if (!/^\d+$/.test(userId)) {
      return res.status(401).json({ success: false, message: 'The signed-in account could not be verified.' });
    }
    participant = db.prepare(`
      SELECT _id AS id, username, full_name AS fullName, role
      FROM users
      WHERE _id = ? AND is_active = 1
    `).get(Number(userId));
    if (!participant) {
      return res.status(401).json({ success: false, message: 'The signed-in account is no longer active.' });
    }
  }

  const accountId = participant ? String(participant.id) : null;
  const participantType = participant ? 'account' : 'guest';
  const participantId = accountId || deviceId;
  const accountRole = participant?.role || null;
  const displayName = participant
    ? (participant.fullName || participant.username || 'Signed-in account')
    : 'Guest visitor';
  const existingConversation = getConversation(conversationId);

  if (existingConversation) {
    if (existingConversation.deviceId !== deviceId || existingConversation.accountId !== accountId) {
      return res.status(403).json({ success: false, message: 'This chat belongs to another account or device.' });
    }
  } else {
    db.prepare(`
      INSERT INTO live_chat_conversations
        (conversation_id, participant_type, participant_id, device_id, account_id, account_role, display_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(conversationId, participantType, participantId, deviceId, accountId, accountRole, displayName);
  }

  return res.json({ success: true, data: getConversation(conversationId) });
});

router.get('/conversations/:conversationId/messages', authenticateOptional, (req, res) => {
  const { conversationId } = req.params;
  const after = Number.parseInt(req.query.after || '0', 10);
  if (!isValidConversationId(conversationId) || !Number.isSafeInteger(after) || after < 0) {
    return res.status(400).json({ success: false, message: 'Invalid chat request.' });
  }
  if (!authorizeClientConversation(req, res, conversationId, req.query.deviceId)) return undefined;
  return res.json({ success: true, data: getMessages(conversationId, after) });
});

router.post('/conversations/:conversationId/messages', authenticateOptional, (req, res) => {
  const { conversationId } = req.params;
  if (!isValidConversationId(conversationId)) {
    return res.status(400).json({ success: false, message: 'Invalid conversation.' });
  }
  if (!authorizeClientConversation(req, res, conversationId, req.body?.deviceId)) return undefined;
  const senderName = getConversation(conversationId)?.displayName || 'Guest visitor';
  return saveMessage(conversationId, 'client', senderName, req.body, res);
});

const sendAttachment = (conversationId, messageId, res) => {
  const attachment = getRawSQLiteDB().prepare(`
    SELECT attachment_name AS name, attachment_mime AS mime, attachment_data AS data
    FROM live_chat_messages
    WHERE _id = ? AND conversation_id = ? AND type IN ('attachment', 'voice')
  `).get(Number(messageId), conversationId);
  if (!attachment) {
    return res.status(404).json({ success: false, message: 'Attachment not found.' });
  }
  const encodedData = attachment.data.split(',').pop();
  const content = Buffer.from(encodedData, 'base64');
  const mime = attachment.mime || 'application/octet-stream';
  res.type(mime);
  res.set('Cache-Control', 'private, max-age=300');
  if (mime.startsWith('image/') || mime.startsWith('audio/') || mime.startsWith('video/')) {
    res.set('Content-Disposition', 'inline');
  } else {
    res.attachment(attachment.name || 'attachment');
  }
  return res.send(content);
};

router.get('/support-status', (req, res) => {
  const online = !!getRawSQLiteDB().prepare(`
    SELECT 1 FROM social_presence presence
    JOIN users u ON CAST(u._id AS TEXT) = presence.user_id
    WHERE LOWER(u.role) IN ('admin', 'root')
      AND u.is_active = 1
      AND presence.last_seen >= datetime('now', '-90 seconds')
    LIMIT 1
  `).get();
  return res.json({ success: true, data: { online } });
});

router.post('/presence', authenticate, (req, res) => {
  if (req.user?.id === undefined || req.user?.id === null) {
    return res.status(401).json({ success: false, message: 'A signed-in account is required.' });
  }
  getRawSQLiteDB().prepare(`
    INSERT INTO social_presence (user_id, last_seen) VALUES (?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET last_seen = CURRENT_TIMESTAMP
  `).run(String(req.user.id));
  return res.json({ success: true, data: { online: true } });
});

router.get('/conversations/:conversationId/attachments/:messageId', authenticateOptional, (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid attachment request.' });
  }
  if (!authorizeClientConversation(req, res, conversationId, req.query.deviceId)) return undefined;
  return sendAttachment(conversationId, messageId, res);
});

router.use('/admin', authenticate, authorize('root', 'admin', 'Root', 'Admin'), requireRootOtpAccess);

router.post('/admin/presence', (req, res) => {
  getRawSQLiteDB().prepare(`
    INSERT INTO social_presence (user_id, last_seen) VALUES (?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET last_seen = CURRENT_TIMESTAMP
  `).run(String(req.user.id));
  return res.json({ success: true, data: { online: true } });
});

router.get('/admin/conversations', (req, res) => {
  const conversations = getRawSQLiteDB().prepare(`
    SELECT conversationId, lastMessageId, updatedAt,
           lastMessage, lastMessageType, participantType, participantId,
           deviceId, accountId, accountRole, displayName,
           EXISTS(SELECT 1 FROM social_presence presence
             JOIN users online_user ON CAST(online_user._id AS TEXT) = presence.user_id
             WHERE presence.user_id = chats.accountId AND online_user.is_active = 1
               AND presence.last_seen >= datetime('now', '-90 seconds')) AS isOnline
    FROM (
      SELECT conversations.conversation_id AS conversationId,
             COALESCE((SELECT MAX(_id) FROM live_chat_messages
                       WHERE conversation_id = conversations.conversation_id), 0) AS lastMessageId,
             COALESCE((SELECT MAX(created_at) FROM live_chat_messages
                       WHERE conversation_id = conversations.conversation_id), conversations.updated_at) AS updatedAt,
             (SELECT CASE WHEN latest.type LIKE 'call-%' THEN 'Audio call'
                        WHEN latest.type = 'voice' THEN 'Voice message'
                        WHEN latest.type = 'attachment' THEN latest.attachment_name
                        ELSE latest.text END
            FROM live_chat_messages latest
            WHERE latest.conversation_id = conversations.conversation_id
            ORDER BY _id DESC LIMIT 1) AS lastMessage,
           (SELECT type FROM live_chat_messages latest
            WHERE latest.conversation_id = conversations.conversation_id
            ORDER BY _id DESC LIMIT 1) AS lastMessageType,
           conversations.participant_type AS participantType,
           conversations.participant_id AS participantId,
           conversations.device_id AS deviceId,
           conversations.account_id AS accountId,
           conversations.account_role AS accountRole,
           conversations.display_name AS displayName
      FROM live_chat_conversations conversations

      UNION ALL

      SELECT messages.conversation_id AS conversationId,
             MAX(messages._id) AS lastMessageId,
             MAX(messages.created_at) AS updatedAt,
             (SELECT CASE WHEN latest.type LIKE 'call-%' THEN 'Audio call'
                          WHEN latest.type = 'voice' THEN 'Voice message'
                          WHEN latest.type = 'attachment' THEN latest.attachment_name
                          ELSE latest.text END
              FROM live_chat_messages latest
              WHERE latest.conversation_id = messages.conversation_id
              ORDER BY _id DESC LIMIT 1) AS lastMessage,
             (SELECT type FROM live_chat_messages latest
              WHERE latest.conversation_id = messages.conversation_id
              ORDER BY _id DESC LIMIT 1) AS lastMessageType,
             'guest' AS participantType,
             messages.conversation_id AS participantId,
             messages.conversation_id AS deviceId,
             NULL AS accountId,
             NULL AS accountRole,
             'Guest (previous chat)' AS displayName
      FROM live_chat_messages messages
      LEFT JOIN live_chat_conversations conversations
        ON conversations.conversation_id = messages.conversation_id
      WHERE conversations.conversation_id IS NULL
      GROUP BY messages.conversation_id
    ) chats
    ORDER BY lastMessageId DESC
    LIMIT 100
  `).all();
  return res.json({ success: true, data: conversations });
});

router.get('/admin/conversations/:conversationId/messages', (req, res) => {
  const { conversationId } = req.params;
  const after = Number.parseInt(req.query.after || '0', 10);
  if (!isValidConversationId(conversationId) || !Number.isSafeInteger(after) || after < 0) {
    return res.status(400).json({ success: false, message: 'Invalid chat request.' });
  }
  return res.json({ success: true, data: getMessages(conversationId, after) });
});

router.post('/admin/conversations/:conversationId/messages', (req, res) => {
  const { conversationId } = req.params;
  if (!isValidConversationId(conversationId)) {
    return res.status(400).json({ success: false, message: 'Invalid conversation.' });
  }
  const userId = Number(req.user?.id);
  const admin = Number.isSafeInteger(userId) && userId > 0
    ? getRawSQLiteDB().prepare(`
      SELECT username, full_name AS fullName FROM users WHERE _id = ?
    `).get(userId)
    : null;
  const senderName = admin?.fullName || admin?.username || req.user?.username || 'Support';
  return saveMessage(conversationId, 'admin', senderName, req.body, res);
});

router.get('/admin/conversations/:conversationId/attachments/:messageId', (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid attachment request.' });
  }
  return sendAttachment(conversationId, messageId, res);
});

export default router;
