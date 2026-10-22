import { randomInt, randomUUID } from 'crypto';
import { queryNeon, withNeonTransaction } from '../config/neonDatabase.js';
import { creditUserCoins, getUserCoinBalance } from './socialController.js';

const GAME_META = {
  wheel: { title: 'Spin & Win', icon: '🎡' },
  slots: { title: 'Lucky Slots', icon: '🎰' },
  'boom-mines': { title: 'Boom Mine', icon: '💎' },
};
const MAX_COINS = 1000000000;

const json = (res, data, status = 200) => res.status(status).json({ success: true, data });
const readGames = async () => {
  const { rows } = await queryNeon('SELECT games_json FROM daily_game_reward_settings WHERE setting_id = 1');
  const row = rows[0];
  if (!row) throw new Error('Daily game reward settings are missing.');
  const games = JSON.parse(row.games_json);
  for (const [id, meta] of Object.entries(GAME_META)) {
    const game = games[id];
    if (!game || typeof game.enabled !== 'boolean' || !Number.isSafeInteger(game.playsPer24Hours) ||
        game.playsPer24Hours < 1 || game.playsPer24Hours > 10 ||
        !Array.isArray(game.segments) || game.segments.length < 2 || game.segments.length > 12 ||
        game.segments.some(segment => !segment || typeof segment.id !== 'string' ||
          typeof segment.label !== 'string' || !segment.label.trim() || segment.label.length > 40 ||
          !Number.isSafeInteger(segment.coins) || segment.coins < 0 || segment.coins > MAX_COINS)) {
      throw new Error(`Daily game reward settings for ${meta.title} are invalid.`);
    }
  }
  if (Object.keys(games).some(id => !Object.hasOwn(GAME_META, id))) {
    throw new Error('Daily game reward settings contain an unknown game.');
  }
  return games;
};

const normalizeGames = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const games = {};
  for (const [id, meta] of Object.entries(GAME_META)) {
    const game = value[id];
    if (!game || typeof game !== 'object' || Array.isArray(game) ||
        typeof game.enabled !== 'boolean' ||
        !Number.isSafeInteger(Number(game.playsPer24Hours)) ||
        Number(game.playsPer24Hours) < 1 || Number(game.playsPer24Hours) > 10 ||
        !Array.isArray(game.segments) || game.segments.length < 2 || game.segments.length > 12) {
      return null;
    }
    const segmentIds = new Set();
    const segments = [];
    for (const segment of game.segments) {
      const segmentId = String(segment?.id || '').trim();
      const label = String(segment?.label || '').trim();
      const coins = Number(segment?.coins);
      if (!/^[a-z0-9_-]{1,40}$/i.test(segmentId) || segmentIds.has(segmentId) ||
          !label || label.length > 40 || !Number.isSafeInteger(coins) || coins < 0 || coins > MAX_COINS) {
        return null;
      }
      segmentIds.add(segmentId);
      segments.push({ id: segmentId, label, coins });
    }
    games[id] = {
      enabled: game.enabled,
      playsPer24Hours: Number(game.playsPer24Hours),
      segments,
    };
    if (!meta.title) return null;
  }
  if (Object.keys(value).some(id => !Object.hasOwn(GAME_META, id))) return null;
  return games;
};

const getGameStatus = async (userId, gameId, game) => {
  const { rows: plays } = await queryNeon(`
    SELECT played_at FROM daily_game_reward_plays
    WHERE user_id = $1 AND game_id = $2
      AND played_at::timestamptz > CURRENT_TIMESTAMP - INTERVAL '24 hours'
    ORDER BY played_at::timestamptz ASC
  `, [String(userId), gameId]);
  const nextAvailableAt = plays.length >= game.playsPer24Hours
    ? new Date(plays[0].played_at).getTime() + 24 * 60 * 60 * 1000
    : null;
  return {
    playsUsed: plays.length,
    playsLimit: game.playsPer24Hours,
    nextAvailableAt: nextAvailableAt ? new Date(nextAvailableAt).toISOString() : null,
  };
};

const gamePayload = async (userId, games) => Promise.all(Object.entries(games).map(async ([id, game]) => ({
  id,
  title: GAME_META[id].title,
  icon: GAME_META[id].icon,
  enabled: game.enabled,
  playsPer24Hours: game.playsPer24Hours,
  segments: game.segments,
  ...await getGameStatus(userId, id, game),
})));

export const getDailyGameRewards = async (req, res, next) => {
  try {
    json(res, { games: await gamePayload(req.user.id, await readGames()) });
  } catch (error) {
    next(error);
  }
};

export const playDailyRewardGame = async (req, res, next) => {
  try {
    const userId = String(req.user.id);
    const gameId = String(req.params.gameId || '');
    const requestId = String(req.body?.requestId || '');
    if (!Object.hasOwn(GAME_META, gameId)) {
      return res.status(404).json({ success: false, message: 'That reward game is not available.' });
    }
    if (!/^[a-z0-9-]{16,80}$/i.test(requestId)) {
      return res.status(400).json({ success: false, message: 'A valid play request ID is required.' });
    }

    const play = await withNeonTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [requestId]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`daily-game:${userId}:${gameId}`]);
      const existingResult = await client.query(
        'SELECT * FROM daily_game_reward_plays WHERE request_id = $1 AND user_id = $2 FOR UPDATE',
        [requestId, userId]
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.game_id !== gameId) {
          const error = new Error('This play request ID was already used for a different game.');
          error.statusCode = 409;
          throw error;
        }
        return existing;
      }

      const settingsResult = await client.query('SELECT games_json FROM daily_game_reward_settings WHERE setting_id = 1');
      const settingsRow = settingsResult.rows[0];
      if (!settingsRow) throw new Error('Daily game reward settings are missing.');
      const games = JSON.parse(settingsRow.games_json);
      const game = games[gameId];
      if (!game.enabled) {
        const error = new Error('This reward game is temporarily disabled.');
        error.statusCode = 409;
        throw error;
      }
      const playsResult = await client.query(`
        SELECT played_at FROM daily_game_reward_plays
        WHERE user_id = $1 AND game_id = $2
          AND played_at::timestamptz > CURRENT_TIMESTAMP - INTERVAL '24 hours'
        ORDER BY played_at::timestamptz ASC
      `, [userId, gameId]);
      const plays = playsResult.rows;
      const nextAvailableAt = plays.length >= game.playsPer24Hours
        ? new Date(plays[0].played_at).getTime() + 24 * 60 * 60 * 1000
        : null;
      const status = {
        playsUsed: plays.length,
        playsLimit: game.playsPer24Hours,
        nextAvailableAt: nextAvailableAt ? new Date(nextAvailableAt).toISOString() : null,
      };
      if (status.playsUsed >= status.playsLimit) {
        const error = new Error(`You have used all ${status.playsLimit} plays. Try again when your 24-hour cooldown ends.`);
        error.statusCode = 429;
        error.nextAvailableAt = status.nextAvailableAt;
        throw error;
      }

      const segment = game.segments[randomInt(game.segments.length)];
      const playId = randomUUID();
      const insert = await client.query(`
        INSERT INTO daily_game_reward_plays (
          play_id, request_id, user_id, game_id, segment_id, segment_label, coins_awarded
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [playId, requestId, userId, gameId, segment.id, segment.label, segment.coins]);
      return insert.rows[0];
    });

    if (play.coins_awarded > 0) {
      const reference = `daily-game:${play.play_id}`;
      const credited = await creditUserCoins(
        userId,
        play.coins_awarded,
        'daily_game_reward',
        reference,
        `${GAME_META[gameId].title} reward: ${play.segment_label}`,
      );
      if (!credited) {
        const { rows } = await queryNeon('SELECT 1 FROM wallet_coin_ledger WHERE reference = $1', [reference]);
        if (!rows.length) throw new Error('Your coin reward could not be credited.');
      }
    }

    const games = await readGames();
    const game = games[gameId];
    json(res, {
      play: {
        playId: play.play_id,
        gameId,
        segmentId: play.segment_id,
        segmentLabel: play.segment_label,
        coinsAwarded: play.coins_awarded,
        playedAt: `${play.played_at.replace(' ', 'T')}Z`,
        coinBalance: await getUserCoinBalance(userId),
      },
      games: await gamePayload(userId, games),
    }, 201);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
        ...(error.nextAvailableAt ? { nextAvailableAt: error.nextAvailableAt } : {}),
      });
    }
    next(error);
  }
};

export const getRootDailyGameRewardSettings = async (req, res, next) => {
  try {
    json(res, await readGames());
  } catch (error) {
    next(error);
  }
};

export const saveRootDailyGameRewardSettings = async (req, res, next) => {
  try {
    const games = normalizeGames(req.body?.games);
    if (!games) {
      return res.status(400).json({
        success: false,
        message: 'Enter 1–10 plays per 24 hours and 2–12 segments per game with valid labels and non-negative whole coin rewards.',
      });
    }
    const result = await queryNeon(`
      UPDATE daily_game_reward_settings
      SET games_json = $1, updated_at = CURRENT_TIMESTAMP::text
      WHERE setting_id = 1
    `, [JSON.stringify(games)]);
    if (result.rowCount !== 1) throw new Error('Daily game reward settings were not saved.');
    json(res, games);
  } catch (error) {
    next(error);
  }
};
