import { randomUUID } from 'crypto';
import { getRawSQLiteDB } from '../config/sqliteDatabase.js';

export const recordPlatformPayout = ({ userId, agentUserId = null, amount, requestId, entryType, reference, description }) => {
  const payoutAmount = Math.round(Number(amount) * 100) / 100;
  if (!userId || !requestId || !entryType || !reference || !description ||
      !Number.isFinite(payoutAmount) || payoutAmount <= 0) {
    throw new Error('Platform payout details are invalid.');
  }

  getRawSQLiteDB().prepare(`
    INSERT INTO platform_payout_ledger (
      payout_id, user_id, agent_user_id, amount, request_id, entry_type, reference, description
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), String(userId), agentUserId == null ? null : String(agentUserId),
    -payoutAmount, String(requestId), String(entryType), String(reference), String(description)
  );
};
