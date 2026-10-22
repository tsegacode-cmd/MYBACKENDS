import { randomUUID } from 'crypto';
import { queryNeon } from '../config/neonDatabase.js';

export const recordPlatformPayout = async (
  { userId, agentUserId = null, amount, requestId, entryType, reference, description },
  client = null
) => {
  const payoutAmount = Math.round(Number(amount) * 100) / 100;
  if (!userId || !requestId || !entryType || !reference || !description ||
      !Number.isFinite(payoutAmount) || payoutAmount <= 0) {
    throw new Error('Platform payout details are invalid.');
  }

  const sql = `
    INSERT INTO platform_payout_ledger (
      payout_id, user_id, agent_user_id, amount, request_id, entry_type, reference, description
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `;
  const params = [
    randomUUID(), String(userId), agentUserId == null ? null : String(agentUserId),
    -payoutAmount, String(requestId), String(entryType), String(reference), String(description)
  ];

  if (client) {
    await client.query(sql, params);
    return;
  }

  await queryNeon(sql, params);
};
