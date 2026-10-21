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

const getMessages = (conversationId, after = 0, senderIdentity = '') => getRawSQLiteDB().prepare(`
  SELECT messages._id AS id, messages.conversation_id AS conversationId,
         messages.sender, COALESCE(messages.sender_name,
           CASE WHEN messages.sender = 'client' THEN conversations.display_name ELSE 'Support' END
         ) AS senderName,
         messages.type,
         CASE WHEN messages.deleted_at IS NULL THEN messages.text ELSE '' END AS text,
         messages.edited_at AS editedAt, messages.deleted_at AS deletedAt,
         (messages.sender_identity = ?) AS canEdit,
         messages.reply_to_message_id AS replyToMessageId,
         messages.forwarded_from_message_id AS forwardedFromMessageId,
         reply.sender AS replySender, reply.type AS replyType,
         CASE WHEN reply.deleted_at IS NULL THEN reply.text ELSE '' END AS replyText,
         reply.deleted_at AS replyDeletedAt,
         COALESCE(reply.sender_name, CASE WHEN reply.sender = 'client' THEN conversations.display_name ELSE 'Support' END) AS replySenderName,
         COALESCE(forwarded.sender_name, CASE WHEN forwarded.sender = 'client' THEN conversations.display_name ELSE 'Support' END) AS forwardedFromName,
         messages.attachment_name AS attachmentName, messages.attachment_mime AS attachmentMime,
         messages.created_at AS createdAt
  FROM live_chat_messages messages
  LEFT JOIN live_chat_conversations conversations
    ON conversations.conversation_id = messages.conversation_id
  LEFT JOIN live_chat_messages reply
    ON reply._id = messages.reply_to_message_id AND reply.conversation_id = messages.conversation_id
  LEFT JOIN live_chat_messages forwarded
    ON forwarded._id = messages.forwarded_from_message_id AND forwarded.conversation_id = messages.conversation_id
  WHERE messages.conversation_id = ? AND messages._id > ?
  ORDER BY messages._id ASC
  LIMIT 100
`).all(senderIdentity, conversationId, after);

const saveMessage = (conversationId, sender, senderName, senderIdentity, body, res) => {
  const payload = body && typeof body === 'object' ? body : {};
  const type = payload.type === undefined ? 'text' : payload.type;
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const attachment = payload.attachment;
  const replyToMessageId = payload.replyToMessageId == null ? null : Number(payload.replyToMessageId);
  const forwardedFromMessageId = payload.forwardedFromMessageId == null ? null : Number(payload.forwardedFromMessageId);

  if (typeof type !== 'string') {
    return res.status(400).json({ success: false, message: 'A valid message is required.' });
  }
  const maxTextLength = type === 'text' ? 4000
    : type === 'attachment' && attachment?.mime?.startsWith('image/') ? 1000
      : type.startsWith('call-') ? 128 * 1024 : 0;
  if (!messageTypes.has(type) || (type === 'text' && !text) || text.length > maxTextLength ||
    (replyToMessageId !== null && (!Number.isSafeInteger(replyToMessageId) ||
      !getRawSQLiteDB().prepare('SELECT 1 FROM live_chat_messages WHERE _id = ? AND conversation_id = ?').get(replyToMessageId, conversationId))) ||
    (forwardedFromMessageId !== null && (!Number.isSafeInteger(forwardedFromMessageId) ||
      !getRawSQLiteDB().prepare('SELECT 1 FROM live_chat_messages WHERE _id = ? AND conversation_id = ? AND deleted_at IS NULL').get(forwardedFromMessageId, conversationId)))) {
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
      (conversation_id, sender, sender_name, sender_identity, type, text, attachment_name, attachment_mime, attachment_data,
       reply_to_message_id, forwarded_from_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    conversationId,
    sender,
    senderName,
    senderIdentity,
    type,
    text,
    attachment?.name || null,
    attachment?.mime || null,
    attachment?.data || null,
    replyToMessageId,
    forwardedFromMessageId
  );

  const message = getRawSQLiteDB().prepare(`
    SELECT _id AS id, conversation_id AS conversationId, sender, sender_name AS senderName, type, text,
           attachment_name AS attachmentName, attachment_mime AS attachmentMime,
           created_at AS createdAt, edited_at AS editedAt, deleted_at AS deletedAt,
           reply_to_message_id AS replyToMessageId, forwarded_from_message_id AS forwardedFromMessageId
    FROM live_chat_messages WHERE _id = ?
  `).get(result.lastInsertRowid);
  return res.status(201).json({ success: true, data: message });
};

const updateMessage = (req, res, messageId, conversationId, senderIdentity) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const message = getRawSQLiteDB().prepare(`
    SELECT _id, type, text, created_at, deleted_at, sender_identity, attachment_mime
    FROM live_chat_messages WHERE _id = ? AND conversation_id = ?
  `).get(messageId, conversationId);
  if (!message || message.deleted_at || message.sender_identity !== senderIdentity) {
    return res.status(404).json({ success: false, message: 'Message not found.' });
  }
  const ageDays = getRawSQLiteDB().prepare(`SELECT julianday('now') - julianday(?) AS ageDays`).get(message.created_at).ageDays;
  if (ageDays < 0 || ageDays > 15) {
    return res.status(403).json({ success: false, message: 'Messages can only be edited within 15 days of sending.' });
  }
  const editable = message.type === 'text' || (message.type === 'attachment' && message.attachment_mime?.startsWith('image/'));
  if (!editable || text.length > (message.type === 'text' ? 4000 : 1000) || (message.type === 'text' && !text)) {
    return res.status(400).json({ success: false, message: 'Only text messages and image captions can be edited.' });
  }
  getRawSQLiteDB().prepare('UPDATE live_chat_messages SET text = ?, edited_at = CURRENT_TIMESTAMP WHERE _id = ?')
    .run(text, message._id);
  return res.json({ success: true, data: { updated: true } });
};

const deleteMessage = (req, res, messageId, conversationId, senderIdentity) => {
  const result = getRawSQLiteDB().prepare(`
    UPDATE live_chat_messages SET text = '', attachment_data = NULL, deleted_at = CURRENT_TIMESTAMP
    WHERE _id = ? AND conversation_id = ? AND sender_identity = ? AND deleted_at IS NULL
  `).run(messageId, conversationId, senderIdentity);
  if (!result.changes) return res.status(404).json({ success: false, message: 'Message not found.' });
  return res.json({ success: true, data: { deleted: true } });
};

const forwardMessage = (req, res, messageId, conversationId, sender, senderName, senderIdentity) => {
  const source = getRawSQLiteDB().prepare(`
    SELECT type, text, attachment_name, attachment_mime, attachment_data, deleted_at
    FROM live_chat_messages WHERE _id = ? AND conversation_id = ?
  `).get(messageId, conversationId);
  if (!source || source.deleted_at || source.type.startsWith('call-')) {
    return res.status(404).json({ success: false, message: 'That message cannot be forwarded.' });
  }
  return saveMessage(conversationId, sender, senderName, senderIdentity, {
    type: source.type,
    text: source.text,
    attachment: source.attachment_data ? {
      name: source.attachment_name,
      mime: source.attachment_mime,
      data: source.attachment_data,
    } : undefined,
    forwardedFromMessageId: messageId,
  }, res);
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
  const conversation = getConversation(conversationId);
  const senderIdentity = `client:${conversation.accountId || req.query.deviceId}`;
  return res.json({ success: true, data: getMessages(conversationId, after, senderIdentity) });
});

router.post('/conversations/:conversationId/messages', authenticateOptional, (req, res) => {
  const { conversationId } = req.params;
  if (!isValidConversationId(conversationId)) {
    return res.status(400).json({ success: false, message: 'Invalid conversation.' });
  }
  if (!authorizeClientConversation(req, res, conversationId, req.body?.deviceId)) return undefined;
  const senderName = getConversation(conversationId)?.displayName || 'Guest visitor';
  const senderIdentity = `client:${getConversation(conversationId)?.accountId || req.body.deviceId}`;
  return saveMessage(conversationId, 'client', senderName, senderIdentity, req.body, res);
});

router.patch('/conversations/:conversationId/messages/:messageId', authenticateOptional, (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid message request.' });
  }
  if (!authorizeClientConversation(req, res, conversationId, req.body?.deviceId)) return undefined;
  const conversation = getConversation(conversationId);
  return updateMessage(req, res, Number(messageId), conversationId, `client:${conversation.accountId || req.body.deviceId}`);
});

router.delete('/conversations/:conversationId/messages/:messageId', authenticateOptional, (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid message request.' });
  }
  if (!authorizeClientConversation(req, res, conversationId, req.body?.deviceId)) return undefined;
  const conversation = getConversation(conversationId);
  return deleteMessage(req, res, Number(messageId), conversationId, `client:${conversation.accountId || req.body.deviceId}`);
});

router.post('/conversations/:conversationId/messages/:messageId/forward', authenticateOptional, (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid message request.' });
  }
  if (!authorizeClientConversation(req, res, conversationId, req.body?.deviceId)) return undefined;
  const conversation = getConversation(conversationId);
  return forwardMessage(
    req,
    res,
    Number(messageId),
    conversationId,
    'client',
    conversation.displayName || 'Guest visitor',
    `client:${conversation.accountId || req.body.deviceId}`
  );
});

const sendAttachment = (conversationId, messageId, res) => {
  const attachment = getRawSQLiteDB().prepare(`
    SELECT attachment_name AS name, attachment_mime AS mime, attachment_data AS data
    FROM live_chat_messages
    WHERE _id = ? AND conversation_id = ? AND type IN ('attachment', 'voice') AND deleted_at IS NULL
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
  return res.json({ success: true, data: getMessages(conversationId, after, `admin:${String(req.user.id)}`) });
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
  const senderIdentity = `admin:${String(req.user.id)}`;
  return saveMessage(conversationId, 'admin', senderName, senderIdentity, req.body, res);
});

router.patch('/admin/conversations/:conversationId/messages/:messageId', (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid message request.' });
  }
  return updateMessage(req, res, Number(messageId), conversationId, `admin:${String(req.user.id)}`);
});

router.delete('/admin/conversations/:conversationId/messages/:messageId', (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid message request.' });
  }
  return deleteMessage(req, res, Number(messageId), conversationId, `admin:${String(req.user.id)}`);
});

router.post('/admin/conversations/:conversationId/messages/:messageId/forward', (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid message request.' });
  }
  const admin = Number(req.user?.id);
  const user = Number.isSafeInteger(admin) && admin > 0
    ? getRawSQLiteDB().prepare('SELECT username, full_name AS fullName FROM users WHERE _id = ?').get(admin)
    : null;
  return forwardMessage(
    req,
    res,
    Number(messageId),
    conversationId,
    'admin',
    user?.fullName || user?.username || 'Support',
    `admin:${String(req.user.id)}`
  );
});

router.get('/admin/conversations/:conversationId/attachments/:messageId', (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid attachment request.' });
  }
  return sendAttachment(conversationId, messageId, res);
});

export default router;
