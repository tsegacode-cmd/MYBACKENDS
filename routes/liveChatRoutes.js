import express from 'express';
import { queryNeon } from '../config/neonDatabase.js';
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
const queryRows = async (sql, params = []) => (await queryNeon(sql, params)).rows;
const queryFirst = async (sql, params = []) => (await queryNeon(sql, params)).rows[0];
const asyncRoute = handler => (req, res, next) =>
  Promise.resolve(handler(req, res)).catch(next);

const isValidConversationId = value =>
  typeof value === 'string' && conversationIdPattern.test(value);

const getConversation = conversationId => queryFirst(`
  SELECT conversation_id AS "conversationId", participant_type AS "participantType",
         participant_id AS "participantId", device_id AS "deviceId", account_id AS "accountId",
         display_name AS "displayName"
  FROM live_chat_conversations
  WHERE conversation_id = ?
`, [conversationId]);

const authorizeClientConversation = async (req, res, conversationId, deviceId) => {
  if (typeof deviceId !== 'string' || !isValidConversationId(deviceId)) {
    res.status(400).json({ success: false, message: 'A valid device ID is required.' });
    return false;
  }

  const conversation = await getConversation(conversationId);
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

const getMessages = (conversationId, after = 0, senderIdentity = '') => queryRows(`
  SELECT messages._id AS id, messages.conversation_id AS "conversationId",
         messages.sender, COALESCE(messages.sender_name,
           CASE WHEN messages.sender = 'client' THEN conversations.display_name ELSE 'Support' END
         ) AS "senderName",
         messages.type,
         CASE WHEN messages.deleted_at IS NULL THEN messages.text ELSE '' END AS text,
         messages.edited_at AS "editedAt", messages.deleted_at AS "deletedAt",
         (messages.sender_identity = ?) AS "canEdit",
         messages.reply_to_message_id AS "replyToMessageId",
         messages.forwarded_from_message_id AS "forwardedFromMessageId",
         reply.sender AS "replySender", reply.type AS "replyType",
         CASE WHEN reply.deleted_at IS NULL THEN reply.text ELSE '' END AS "replyText",
         reply.deleted_at AS "replyDeletedAt",
         COALESCE(reply.sender_name, CASE WHEN reply.sender = 'client' THEN conversations.display_name ELSE 'Support' END) AS "replySenderName",
         COALESCE(forwarded.sender_name, CASE WHEN forwarded.sender = 'client' THEN conversations.display_name ELSE 'Support' END) AS "forwardedFromName",
         messages.attachment_name AS "attachmentName", messages.attachment_mime AS "attachmentMime",
         messages.created_at AS "createdAt"
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
`, [senderIdentity, conversationId, after]);

const saveMessage = async (conversationId, sender, senderName, senderIdentity, body, res) => {
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
      !await queryFirst('SELECT 1 FROM live_chat_messages WHERE _id = ? AND conversation_id = ?', [replyToMessageId, conversationId]))) ||
    (forwardedFromMessageId !== null && (!Number.isSafeInteger(forwardedFromMessageId) ||
      !await queryFirst('SELECT 1 FROM live_chat_messages WHERE _id = ? AND conversation_id = ? AND deleted_at IS NULL', [forwardedFromMessageId, conversationId])))) {
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

  const result = await queryFirst(`
    INSERT INTO live_chat_messages
      (conversation_id, sender, sender_name, sender_identity, type, text, attachment_name, attachment_mime, attachment_data,
       reply_to_message_id, forwarded_from_message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING _id
  `, [
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
    forwardedFromMessageId,
  ]);

  const message = await queryFirst(`
    SELECT _id AS id, conversation_id AS "conversationId", sender, sender_name AS "senderName", type, text,
           attachment_name AS "attachmentName", attachment_mime AS "attachmentMime",
           created_at AS "createdAt", edited_at AS "editedAt", deleted_at AS "deletedAt",
           reply_to_message_id AS "replyToMessageId", forwarded_from_message_id AS "forwardedFromMessageId"
    FROM live_chat_messages WHERE _id = ?
  `, [result._id]);
  return res.status(201).json({ success: true, data: message });
};

const updateMessage = async (req, res, messageId, conversationId, senderIdentity) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const message = await queryFirst(`
    SELECT _id, type, text, created_at, deleted_at, sender_identity, attachment_mime
    FROM live_chat_messages WHERE _id = ? AND conversation_id = ?
  `, [messageId, conversationId]);
  if (!message || message.deleted_at || message.sender_identity !== senderIdentity) {
    return res.status(404).json({ success: false, message: 'Message not found.' });
  }
  const editableAge = await queryFirst(`
    SELECT created_at::timestamptz <= CURRENT_TIMESTAMP
      AND created_at::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '15 days' AS editable
    FROM live_chat_messages WHERE _id = ?
  `, [message._id]);
  if (!editableAge?.editable) {
    return res.status(403).json({ success: false, message: 'Messages can only be edited within 15 days of sending.' });
  }
  const editable = message.type === 'text' || (message.type === 'attachment' && message.attachment_mime?.startsWith('image/'));
  if (!editable || text.length > (message.type === 'text' ? 4000 : 1000) || (message.type === 'text' && !text)) {
    return res.status(400).json({ success: false, message: 'Only text messages and image captions can be edited.' });
  }
  const updated = await queryNeon(`
    UPDATE live_chat_messages SET text = ?, edited_at = CURRENT_TIMESTAMP
    WHERE _id = ? AND sender_identity = ? AND deleted_at IS NULL
    RETURNING _id
  `, [text, message._id, senderIdentity]);
  if (!updated.rowCount) return res.status(404).json({ success: false, message: 'Message not found.' });
  return res.json({ success: true, data: { updated: true } });
};

const deleteMessage = async (req, res, messageId, conversationId, senderIdentity) => {
  const result = await queryNeon(`
    UPDATE live_chat_messages SET text = '', attachment_data = NULL, deleted_at = CURRENT_TIMESTAMP
    WHERE _id = ? AND conversation_id = ? AND sender_identity = ? AND deleted_at IS NULL
  `, [messageId, conversationId, senderIdentity]);
  if (!result.rowCount) return res.status(404).json({ success: false, message: 'Message not found.' });
  return res.json({ success: true, data: { deleted: true } });
};

const forwardMessage = async (req, res, messageId, conversationId, sender, senderName, senderIdentity) => {
  const source = await queryFirst(`
    SELECT type, text, attachment_name, attachment_mime, attachment_data, deleted_at
    FROM live_chat_messages WHERE _id = ? AND conversation_id = ?
  `, [messageId, conversationId]);
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

router.post('/conversations/:conversationId/register', authenticateOptional, asyncRoute(async (req, res) => {
  const { conversationId } = req.params;
  const { deviceId } = req.body || {};
  if (!isValidConversationId(conversationId) || !isValidConversationId(deviceId)) {
    return res.status(400).json({ success: false, message: 'Invalid chat session or device ID.' });
  }

  let participant;
  if (req.user?.id !== undefined) {
    const userId = String(req.user.id);
    if (!/^\d+$/.test(userId)) {
      return res.status(401).json({ success: false, message: 'The signed-in account could not be verified.' });
    }
    participant = await queryFirst(`
      SELECT _id AS id, username, full_name AS "fullName", role
      FROM users
      WHERE _id = ? AND is_active = 1
    `, [Number(userId)]);
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
  const existingConversation = await getConversation(conversationId);

  if (existingConversation) {
    if (existingConversation.deviceId !== deviceId || existingConversation.accountId !== accountId) {
      return res.status(403).json({ success: false, message: 'This chat belongs to another account or device.' });
    }
  } else {
    await queryNeon(`
      INSERT INTO live_chat_conversations
        (conversation_id, participant_type, participant_id, device_id, account_id, account_role, display_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (conversation_id) DO NOTHING
    `, [conversationId, participantType, participantId, deviceId, accountId, accountRole, displayName]);
  }

  const savedConversation = await getConversation(conversationId);
  if (savedConversation.deviceId !== deviceId || savedConversation.accountId !== accountId) {
    return res.status(403).json({ success: false, message: 'This chat belongs to another account or device.' });
  }
  return res.json({ success: true, data: savedConversation });
}));

router.get('/conversations/:conversationId/messages', authenticateOptional, asyncRoute(async (req, res) => {
  const { conversationId } = req.params;
  const after = Number.parseInt(req.query.after || '0', 10);
  if (!isValidConversationId(conversationId) || !Number.isSafeInteger(after) || after < 0) {
    return res.status(400).json({ success: false, message: 'Invalid chat request.' });
  }
  if (!await authorizeClientConversation(req, res, conversationId, req.query.deviceId)) return undefined;
  const conversation = await getConversation(conversationId);
  const senderIdentity = `client:${conversation.accountId || req.query.deviceId}`;
  return res.json({ success: true, data: await getMessages(conversationId, after, senderIdentity) });
}));

router.post('/conversations/:conversationId/messages', authenticateOptional, asyncRoute(async (req, res) => {
  const { conversationId } = req.params;
  if (!isValidConversationId(conversationId)) {
    return res.status(400).json({ success: false, message: 'Invalid conversation.' });
  }
  if (!await authorizeClientConversation(req, res, conversationId, req.body?.deviceId)) return undefined;
  const conversation = await getConversation(conversationId);
  const senderIdentity = `client:${conversation.accountId || req.body.deviceId}`;
  return saveMessage(conversationId, 'client', conversation.displayName || 'Guest visitor', senderIdentity, req.body, res);
}));

router.patch('/conversations/:conversationId/messages/:messageId', authenticateOptional, asyncRoute(async (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid message request.' });
  }
  if (!await authorizeClientConversation(req, res, conversationId, req.body?.deviceId)) return undefined;
  const conversation = await getConversation(conversationId);
  return updateMessage(req, res, Number(messageId), conversationId, `client:${conversation.accountId || req.body.deviceId}`);
}));

router.delete('/conversations/:conversationId/messages/:messageId', authenticateOptional, asyncRoute(async (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid message request.' });
  }
  if (!await authorizeClientConversation(req, res, conversationId, req.body?.deviceId)) return undefined;
  const conversation = await getConversation(conversationId);
  return deleteMessage(req, res, Number(messageId), conversationId, `client:${conversation.accountId || req.body.deviceId}`);
}));

router.post('/conversations/:conversationId/messages/:messageId/forward', authenticateOptional, asyncRoute(async (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid message request.' });
  }
  if (!await authorizeClientConversation(req, res, conversationId, req.body?.deviceId)) return undefined;
  const conversation = await getConversation(conversationId);
  return forwardMessage(
    req,
    res,
    Number(messageId),
    conversationId,
    'client',
    conversation.displayName || 'Guest visitor',
    `client:${conversation.accountId || req.body.deviceId}`
  );
}));

const sendAttachment = async (conversationId, messageId, res) => {
  const attachment = await queryFirst(`
    SELECT attachment_name AS name, attachment_mime AS mime, attachment_data AS data
    FROM live_chat_messages
    WHERE _id = ? AND conversation_id = ? AND type IN ('attachment', 'voice') AND deleted_at IS NULL
  `, [Number(messageId), conversationId]);
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

router.get('/support-status', asyncRoute(async (req, res) => {
  const online = !!await queryFirst(`
    SELECT 1 FROM social_presence presence
    JOIN users u ON u._id::text = presence.user_id
    WHERE LOWER(u.role) IN ('admin', 'root')
      AND u.is_active = 1
      AND presence.last_seen::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '90 seconds'
    LIMIT 1
  `);
  return res.json({ success: true, data: { online } });
}));

router.post('/presence', authenticate, asyncRoute(async (req, res) => {
  if (req.user?.id === undefined || req.user?.id === null) {
    return res.status(401).json({ success: false, message: 'A signed-in account is required.' });
  }
  await queryNeon(`
    INSERT INTO social_presence (user_id, last_seen) VALUES (?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET last_seen = CURRENT_TIMESTAMP
  `, [String(req.user.id)]);
  return res.json({ success: true, data: { online: true } });
}));

router.get('/conversations/:conversationId/attachments/:messageId', authenticateOptional, asyncRoute(async (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid attachment request.' });
  }
  if (!await authorizeClientConversation(req, res, conversationId, req.query.deviceId)) return undefined;
  return sendAttachment(conversationId, messageId, res);
}));

router.use('/admin', authenticate, authorize('root', 'admin', 'Root', 'Admin'), requireRootOtpAccess);

router.post('/admin/presence', asyncRoute(async (req, res) => {
  await queryNeon(`
    INSERT INTO social_presence (user_id, last_seen) VALUES (?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET last_seen = CURRENT_TIMESTAMP
  `, [String(req.user.id)]);
  return res.json({ success: true, data: { online: true } });
}));

router.get('/admin/conversations', asyncRoute(async (req, res) => {
  const conversations = await queryRows(`
    WITH chat_ids AS (
      SELECT conversation_id FROM live_chat_conversations
      UNION
      SELECT DISTINCT messages.conversation_id
      FROM live_chat_messages messages
      LEFT JOIN live_chat_conversations conversations
        ON conversations.conversation_id = messages.conversation_id
      WHERE conversations.conversation_id IS NULL
    )
    SELECT chats.conversation_id AS "conversationId",
           COALESCE(latest._id, 0) AS "lastMessageId",
           COALESCE(latest.created_at::text, conversations.updated_at::text) AS "updatedAt",
           CASE WHEN latest.type LIKE 'call-%' THEN 'Audio call'
                WHEN latest.type = 'voice' THEN 'Voice message'
                WHEN latest.type = 'attachment' THEN latest.attachment_name
                ELSE latest.text END AS "lastMessage",
           latest.type AS "lastMessageType",
           COALESCE(conversations.participant_type, 'guest') AS "participantType",
           COALESCE(conversations.participant_id, chats.conversation_id) AS "participantId",
           COALESCE(conversations.device_id, chats.conversation_id) AS "deviceId",
           conversations.account_id AS "accountId",
           conversations.account_role AS "accountRole",
           COALESCE(conversations.display_name, 'Guest (previous chat)') AS "displayName",
           EXISTS (
             SELECT 1 FROM social_presence presence
             JOIN users online_user ON online_user._id::text = presence.user_id
             WHERE presence.user_id = conversations.account_id
               AND online_user.is_active = 1
               AND presence.last_seen::timestamptz >= CURRENT_TIMESTAMP - INTERVAL '90 seconds'
           ) AS "isOnline"
    FROM chat_ids chats
    LEFT JOIN live_chat_conversations conversations
      ON conversations.conversation_id = chats.conversation_id
    LEFT JOIN LATERAL (
      SELECT _id, created_at, type, attachment_name, text
      FROM live_chat_messages
      WHERE conversation_id = chats.conversation_id
      ORDER BY _id DESC
      LIMIT 1
    ) latest ON TRUE
    ORDER BY latest._id DESC NULLS LAST
    LIMIT 100
  `);
  return res.json({ success: true, data: conversations });
}));

router.get('/admin/conversations/:conversationId/messages', asyncRoute(async (req, res) => {
  const { conversationId } = req.params;
  const after = Number.parseInt(req.query.after || '0', 10);
  if (!isValidConversationId(conversationId) || !Number.isSafeInteger(after) || after < 0) {
    return res.status(400).json({ success: false, message: 'Invalid chat request.' });
  }
  return res.json({ success: true, data: await getMessages(conversationId, after, `admin:${String(req.user.id)}`) });
}));

router.post('/admin/conversations/:conversationId/messages', asyncRoute(async (req, res) => {
  const { conversationId } = req.params;
  if (!isValidConversationId(conversationId)) {
    return res.status(400).json({ success: false, message: 'Invalid conversation.' });
  }
  const userId = Number(req.user?.id);
  const admin = Number.isSafeInteger(userId) && userId > 0
    ? await queryFirst(`
      SELECT username, full_name AS "fullName" FROM users WHERE _id = ?
    `, [userId])
    : null;
  const senderName = admin?.fullName || admin?.username || req.user?.username || 'Support';
  const senderIdentity = `admin:${String(req.user.id)}`;
  return saveMessage(conversationId, 'admin', senderName, senderIdentity, req.body, res);
}));

router.patch('/admin/conversations/:conversationId/messages/:messageId', asyncRoute(async (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid message request.' });
  }
  return updateMessage(req, res, Number(messageId), conversationId, `admin:${String(req.user.id)}`);
}));

router.delete('/admin/conversations/:conversationId/messages/:messageId', asyncRoute(async (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid message request.' });
  }
  return deleteMessage(req, res, Number(messageId), conversationId, `admin:${String(req.user.id)}`);
}));

router.post('/admin/conversations/:conversationId/messages/:messageId/forward', asyncRoute(async (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid message request.' });
  }
  const admin = Number(req.user?.id);
  const user = Number.isSafeInteger(admin) && admin > 0
    ? await queryFirst('SELECT username, full_name AS "fullName" FROM users WHERE _id = ?', [admin])
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
}));

router.get('/admin/conversations/:conversationId/attachments/:messageId', asyncRoute(async (req, res) => {
  const { conversationId, messageId } = req.params;
  if (!isValidConversationId(conversationId) || !/^\d+$/.test(messageId)) {
    return res.status(400).json({ success: false, message: 'Invalid attachment request.' });
  }
  return sendAttachment(conversationId, messageId, res);
}));

export default router;
