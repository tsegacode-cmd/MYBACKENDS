import { randomInt, randomUUID } from 'crypto';
import { getRawSQLiteDB } from '../config/sqliteDatabase.js';
import { creditUserCoins, getUserCoinBalance } from './socialController.js';

const db = () => getRawSQLiteDB();
const GAME_META = {
  wheel: { title: 'Spin & Win', icon: '🎡' },
  slots: { title: 'Lucky Slots', icon: '🎰' },
  'boom-mines': { title: 'Boom Mine', icon: '💎' },
};
const MAX_COINS = 1000000000;

const json = (res, data, status = 200) => res.status(status).json({ success: true, data });
const readGames = () => {
  const row = db().prepare('SELECT games_json FROM daily_game_reward_settings WHERE setting_id = 1').get();
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

const getGameStatus = (userId, gameId, game) => {
  const plays = db().prepare(`
    SELECT played_at FROM daily_game_reward_plays
    WHERE user_id = ? AND game_id = ? AND datetime(played_at) > datetime('now', '-24 hours')
    ORDER BY datetime(played_at) ASC
  `).all(String(userId), gameId);
  const nextAvailableAt = plays.length >= game.playsPer24Hours
    ? new Date(`${plays[0].played_at.replace(' ', 'T')}Z`).getTime() + 24 * 60 * 60 * 1000
    : null;
  return {
    playsUsed: plays.length,
    playsLimit: game.playsPer24Hours,
    nextAvailableAt: nextAvailableAt ? new Date(nextAvailableAt).toISOString() : null,
  };
};

const gamePayload = (userId, games) => Object.entries(games).map(([id, game]) => ({
  id,
  title: GAME_META[id].title,
  icon: GAME_META[id].icon,
  enabled: game.enabled,
  playsPer24Hours: game.playsPer24Hours,
  segments: game.segments,
  ...getGameStatus(userId, id, game),
}));

export const getDailyGameRewards = (req, res, next) => {
  try {
    json(res, { games: gamePayload(req.user.id, readGames()) });
  } catch (error) {
    next(error);
  }
};

export const playDailyRewardGame = (req, res, next) => {
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

    const play = db().transaction(() => {
      const existing = db().prepare(`
        SELECT * FROM daily_game_reward_plays WHERE request_id = ? AND user_id = ?
      `).get(requestId, userId);
      if (existing) {
        if (existing.game_id !== gameId) {
          const error = new Error('This play request ID was already used for a different game.');
          error.statusCode = 409;
          throw error;
        }
        return existing;
      }

      const games = readGames();
      const game = games[gameId];
      if (!game.enabled) {
        const error = new Error('This reward game is temporarily disabled.');
        error.statusCode = 409;
        throw error;
      }
      const status = getGameStatus(userId, gameId, game);
      if (status.playsUsed >= status.playsLimit) {
        const error = new Error(`You have used all ${status.playsLimit} plays. Try again when your 24-hour cooldown ends.`);
        error.statusCode = 429;
        error.nextAvailableAt = status.nextAvailableAt;
        throw error;
      }

      const segment = game.segments[randomInt(game.segments.length)];
      const playId = randomUUID();
      const insert = db().prepare(`
        INSERT INTO daily_game_reward_plays (
          play_id, request_id, user_id, game_id, segment_id, segment_label, coins_awarded
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(playId, requestId, userId, gameId, segment.id, segment.label, segment.coins);
      if (insert.changes !== 1) throw new Error('Your game play could not be recorded.');
      if (segment.coins > 0 && !creditUserCoins(
        userId,
        segment.coins,
        'daily_game_reward',
        `daily-game:${playId}`,
        `${GAME_META[gameId].title} reward: ${segment.label}`,
      )) {
        throw new Error('Your coin reward could not be credited.');
      }
      return db().prepare('SELECT * FROM daily_game_reward_plays WHERE play_id = ?').get(playId);
    })();

    const games = readGames();
    const game = games[gameId];
    json(res, {
      play: {
        playId: play.play_id,
        gameId,
        segmentId: play.segment_id,
        segmentLabel: play.segment_label,
        coinsAwarded: play.coins_awarded,
        playedAt: `${play.played_at.replace(' ', 'T')}Z`,
        coinBalance: getUserCoinBalance(userId),
      },
      games: gamePayload(userId, games),
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

export const getRootDailyGameRewardSettings = (req, res, next) => {
  try {
    json(res, readGames());
  } catch (error) {
    next(error);
  }
};

export const saveRootDailyGameRewardSettings = (req, res, next) => {
  try {
    const games = normalizeGames(req.body?.games);
    if (!games) {
      return res.status(400).json({
        success: false,
        message: 'Enter 1–10 plays per 24 hours and 2–12 segments per game with valid labels and non-negative whole coin rewards.',
      });
    }
    const result = db().prepare(`
      UPDATE daily_game_reward_settings
      SET games_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE setting_id = 1
    `).run(JSON.stringify(games));
    if (result.changes !== 1) throw new Error('Daily game reward settings were not saved.');
    json(res, games);
  } catch (error) {
    next(error);
  }
};
