const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
// Use native fetch when available
const fetch = global.fetch || require('node-fetch');

function normalizeText(value) {
    return (value || '')
        .toString()
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function generateSessionCode() {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function createRoomName(sessionId) {
    return `multiplayer_session_${sessionId}`;
}

function createMainPool() {
    return new Pool({
        user: process.env.MAIN_DB_USER || process.env.DB_USER || 'postgres',
        host: process.env.MAIN_DB_HOST || process.env.DB_HOST || 'localhost',
        database: process.env.MAIN_DB_NAME || 'lexy',
        password: process.env.MAIN_DB_PASSWORD || process.env.DB_PASSWORD || 'postgres',
        port: process.env.MAIN_DB_PORT || process.env.DB_PORT || 5432,
        ssl: false
    });
}

function createMultiplayerPool() {
    console.log('Multiplayer DB config:', {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD ? '***' : undefined,
        port: process.env.DB_PORT
    });
    return new Pool({
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'multiplayer',
        password: process.env.DB_PASSWORD || 'postgres',
        port: process.env.DB_PORT || 5432,
        ssl: false
    });
}

async function ensureMultiplayerSchema(mpPool) {
    console.log('Creating multiplayer tables in database...');
    await mpPool.query(`
        CREATE TABLE IF NOT EXISTS multiplayer_sessions (
            id SERIAL PRIMARY KEY,
            code VARCHAR(16) UNIQUE NOT NULL,
            host_user_id INTEGER NOT NULL,
            deck_id INTEGER NOT NULL,
            mode VARCHAR(20) NOT NULL DEFAULT 'competitive',
            input_mode VARCHAR(20) NOT NULL DEFAULT 'buttons',
            status VARCHAR(20) NOT NULL DEFAULT 'waiting',
            current_card_index INTEGER NOT NULL DEFAULT 0,
            current_card_started_at TIMESTAMP,
            cards_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            started_at TIMESTAMP,
            finished_at TIMESTAMP,
            duration_seconds INTEGER,
            winner_user_id INTEGER
        )
    `);

    await mpPool.query(`
        CREATE TABLE IF NOT EXISTS multiplayer_session_participants (
            id SERIAL PRIMARY KEY,
            session_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            correct_count INTEGER NOT NULL DEFAULT 0,
            incorrect_count INTEGER NOT NULL DEFAULT 0,
            total_time_ms INTEGER NOT NULL DEFAULT 0,
            score INTEGER NOT NULL DEFAULT 0,
            UNIQUE(session_id, user_id)
        )
    `);

    await mpPool.query(`
        CREATE TABLE IF NOT EXISTS multiplayer_session_invites (
            id SERIAL PRIMARY KEY,
            session_id INTEGER NOT NULL,
            inviter_user_id INTEGER NOT NULL,
            invitee_user_id INTEGER NOT NULL,
            invitee_username VARCHAR(50) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            responded_at TIMESTAMP
        )
    `);

    await mpPool.query(`
        CREATE TABLE IF NOT EXISTS multiplayer_session_answers (
            id SERIAL PRIMARY KEY,
            session_id INTEGER NOT NULL,
            participant_id INTEGER NOT NULL,
            card_index INTEGER NOT NULL,
            answer_text TEXT,
            is_correct BOOLEAN NOT NULL DEFAULT FALSE,
            response_ms INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(session_id, participant_id, card_index)
        )
    `);

    await mpPool.query(`
        CREATE TABLE IF NOT EXISTS multiplayer_user_stats (
            user_id INTEGER PRIMARY KEY,
            wins INTEGER NOT NULL DEFAULT 0,
            correct_answers INTEGER NOT NULL DEFAULT 0,
            total_answers INTEGER NOT NULL DEFAULT 0,
            points INTEGER NOT NULL DEFAULT 0,
            total_time_ms INTEGER NOT NULL DEFAULT 0,
            sessions_played INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Synced copies from the main service
    await mpPool.query(`
        CREATE TABLE IF NOT EXISTS multiplayer_users (
            id INTEGER PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            name VARCHAR(100) NOT NULL,
            avatar VARCHAR(10),
            synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await mpPool.query(`
        CREATE TABLE IF NOT EXISTS multiplayer_decks (
            id INTEGER PRIMARY KEY,
            name VARCHAR(200) NOT NULL,
            synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await mpPool.query(`
        CREATE TABLE IF NOT EXISTS multiplayer_cards (
            id INTEGER PRIMARY KEY,
            deck_id INTEGER NOT NULL,
            front TEXT NOT NULL,
            back TEXT NOT NULL,
            synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (deck_id) REFERENCES multiplayer_decks(id) ON DELETE CASCADE
        )
    `);
}

        // Sync user from the main API
        async function syncUser(mpPool, userId, jwtToken) {
            try {
                const response = await fetch(`http://localhost:3002/api/auth/me`, {
                    headers: { 'Authorization': `Bearer ${jwtToken}` }
                });
                if (!response.ok) {
                    console.error('Failed to fetch user:', response.status, await response.text());
                    return null;
                }
                const data = await response.json();
                const user = data.user;
                if (!user || !user.id) {
                    console.error('Invalid user data:', data);
                    return null;
                }

                await mpPool.query(`
                    INSERT INTO multiplayer_users (id, username, name, avatar, synced_at)
                    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                    ON CONFLICT (id) DO UPDATE SET
                        username = EXCLUDED.username,
                        name = EXCLUDED.name,
                        avatar = EXCLUDED.avatar,
                        synced_at = CURRENT_TIMESTAMP
                `, [user.id, user.username, user.name || 'Пользователь', user.avatar || '👤']);

                return user;
            } catch (error) {
                console.error('Error syncing user:', error);
                return null;
            }
        }

        // Resolve a user by username through the main API
        async function findUserByUsername(username, jwtToken) {
            try {
                const response = await fetch(`http://localhost:3002/api/internal/users/search?username=${encodeURIComponent(username)}`, {
                    headers: { 'Authorization': `Bearer ${jwtToken}` }
                });
                if (!response.ok) throw new Error('User not found');
                return await response.json();
            } catch (error) {
                console.error('Error finding user:', error);
                return null;
            }
        }

        // Sync deck data into multiplayer DB
        async function syncDeck(mpPool, deckId, jwtToken) {
            console.log('Syncing deck:', deckId, 'for multiplayer');
            try {
                const response = await fetch(`http://localhost:3002/api/decks/${deckId}`, {
                    headers: { 'Authorization': `Bearer ${jwtToken}` }
                });
                if (!response.ok) {
                    console.error('Failed to fetch deck:', response.status, await response.text());
                    if (response.status === 404) {
                        console.error('Deck not found or not accessible');
                    }
                    return null;
                }
                const deck = await response.json();
                if (!deck || !deck.id) {
                    console.error('Invalid deck data:', deck);
                    return null;
                }

                await mpPool.query(`
                    INSERT INTO multiplayer_decks (id, name, synced_at)
                    VALUES ($1, $2, CURRENT_TIMESTAMP)
                    ON CONFLICT (id) DO UPDATE SET
                        name = EXCLUDED.name,
                        synced_at = CURRENT_TIMESTAMP
                `, [deck.id, deck.name]);

                // Mirror deck cards too
                const cardsResponse = await fetch(`http://localhost:3002/api/decks/${deckId}/cards`, {
                    headers: { 'Authorization': `Bearer ${jwtToken}` }
                });
                if (cardsResponse.ok) {
                    const data = await cardsResponse.json();
                    const cards = data.cards || [];
                    for (const card of cards) {
                        await mpPool.query(`
                            INSERT INTO multiplayer_cards (id, deck_id, front, back, synced_at)
                            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                            ON CONFLICT (id) DO UPDATE SET
                                front = EXCLUDED.front,
                                back = EXCLUDED.back,
                                synced_at = CURRENT_TIMESTAMP
                        `, [card.id, deckId, card.front, card.back]);
                    }
                } else {
                    console.error('Failed to fetch cards:', cardsResponse.status, await cardsResponse.text());
                }

                return deck;
            } catch (error) {
                console.error('Error syncing deck:', error);
                return null;
            }
        }

async function fetchUser(mpPool, userId) {
    const result = await mpPool.query(
        'SELECT id, username, name, avatar FROM multiplayer_users WHERE id = $1',
        [userId]
    );
    return result.rows[0] || null;
}

function normalizePositiveIntegerId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

async function fetchUsersByIds(mpPool, userIds, mainPool = null) {
    const ids = [...new Set(userIds.filter(Boolean).map((value) => Number(value)))];
    if (ids.length === 0) return new Map();

    const result = await mpPool.query(
        'SELECT id, username, name, avatar FROM multiplayer_users WHERE id = ANY($1::int[])',
        [ids]
    );

    const map = new Map(result.rows.map((row) => [Number(row.id), row]));

    // Fill missing users from the main DB
    const missingIds = ids.filter((id) => !map.has(id));
    if (missingIds.length > 0 && mainPool) {
        try {
            const mainRes = await mainPool.query(
                'SELECT id, username, name, avatar FROM users WHERE id = ANY($1::int[])',
                [missingIds]
            );
            for (const row of mainRes.rows) {
                map.set(Number(row.id), row);
            }
        } catch (e) {
            console.error('Failed to fallback fetch users from main DB:', e.message);
        }
    }

    return map;
}

async function fetchDeck(mpPool, deckId) {
    const numericDeckId = normalizePositiveIntegerId(deckId);
    if (numericDeckId === null) return null;

    const result = await mpPool.query(
        'SELECT id, name FROM multiplayer_decks WHERE id = $1',
        [numericDeckId]
    );
    return result.rows[0] || null;
}

async function fetchDecksByIds(mpPool, deckIds) {
    const ids = [...new Set(deckIds.filter(Boolean).map((value) => Number(value)))];
    if (ids.length === 0) return new Map();

    const result = await mpPool.query(
        'SELECT id, name FROM multiplayer_decks WHERE id = ANY($1::int[])',
        [ids]
    );

    return new Map(result.rows.map((row) => [Number(row.id), row]));
}

// Resolve synced deck data
async function fetchOwnedDeck(mpPool, userId, deckId) {
    const deck = await fetchDeck(mpPool, deckId);
    return deck ? { id: deck.id, name: deck.name } : null;
}

async function fetchDeckCards(mpPool, deckId) {
    const numericDeckId = normalizePositiveIntegerId(deckId);
    if (numericDeckId === null) return [];

    const result = await mpPool.query(
        'SELECT id, front, back FROM multiplayer_cards WHERE deck_id = $1 ORDER BY id ASC',
        [numericDeckId]
    );
    return result.rows;
}

async function loadSession(mpPool, sessionId) {
    const numericSessionId = normalizePositiveIntegerId(sessionId);
    if (numericSessionId === null) return null;

    const result = await mpPool.query('SELECT * FROM multiplayer_sessions WHERE id = $1', [numericSessionId]);
    return result.rows[0] || null;
}

async function loadParticipants(mpPool, sessionId, { activeOnly = true } = {}) {
    const numericSessionId = normalizePositiveIntegerId(sessionId);
    if (numericSessionId === null) return [];

    const result = await mpPool.query(
        `SELECT p.*
         FROM multiplayer_session_participants p
         WHERE p.session_id = $1
           ${activeOnly ? "AND p.status = 'active'" : ''}
         ORDER BY p.joined_at ASC, p.id ASC`,
        [numericSessionId]
    );
    return result.rows;
}

async function loadAnswers(mpPool, sessionId) {
    const numericSessionId = normalizePositiveIntegerId(sessionId);
    if (numericSessionId === null) return [];

    const result = await mpPool.query(
        `SELECT a.*
         FROM multiplayer_session_answers a
         WHERE a.session_id = $1
         ORDER BY a.card_index ASC, a.created_at ASC`,
        [numericSessionId]
    );
    return result.rows;
}

function groupAnswersByCard(answers) {
    return answers.reduce((accumulator, answer) => {
        const key = String(answer.card_index);
        if (!accumulator[key]) accumulator[key] = [];
        accumulator[key].push({
            participantId: answer.participant_id,
            userId: answer.user_id,
            username: answer.username,
            answerText: answer.answer_text,
            isCorrect: answer.is_correct,
            responseMs: answer.response_ms
        });
        return accumulator;
    }, {});
}

async function buildSessionPayload({ mpPool, mainPool = null }, sessionId, viewerUserId = null) {
    const session = await loadSession(mpPool, sessionId);
    if (!session) return null;

    const participants = await loadParticipants(mpPool, sessionId);
    const currentParticipantIds = participants.map((participant) => Number(participant.user_id));
    if (viewerUserId !== null && Number(session.host_user_id) !== Number(viewerUserId) && !currentParticipantIds.includes(Number(viewerUserId))) {
        return null;
    }

    const users = await fetchUsersByIds(mpPool, [session.host_user_id, ...currentParticipantIds], mainPool);
    const cards = Array.isArray(session.cards_snapshot) ? session.cards_snapshot : [];
    const currentCard = cards[session.current_card_index] || null;
    const answers = await loadAnswers(mpPool, sessionId);
    const deck = await fetchDeck(mpPool, session.deck_id);

    return {
        session: {
            id: session.id,
            code: session.code,
            hostUserId: session.host_user_id,
            hostUsername: users.get(Number(session.host_user_id))?.username || 'unknown',
            hostName: users.get(Number(session.host_user_id))?.name || 'Пользователь',
            deckId: session.deck_id,
            deckName: deck?.name || 'Колода',
            mode: session.mode,
            inputMode: session.input_mode,
            status: session.status,
            currentCardIndex: session.current_card_index,
            currentCardStartedAt: session.current_card_started_at,
            createdAt: session.created_at,
            startedAt: session.started_at,
            finishedAt: session.finished_at,
            durationSeconds: session.duration_seconds,
            winnerUserId: session.winner_user_id,
            totalCards: cards.length
        },
        participants: participants.map((participant) => {
            const user = users.get(Number(participant.user_id));
            return {
                id: participant.id,
                userId: participant.user_id,
                username: user?.username || 'unknown',
                name: user?.name || 'Пользователь',
                avatar: user?.avatar || '👤',
                status: participant.status,
                joinedAt: participant.joined_at,
                correctCount: participant.correct_count,
                incorrectCount: participant.incorrect_count,
                totalTimeMs: participant.total_time_ms,
                score: participant.score
            };
        }),
        currentCard,
        cards,
        answersByCard: groupAnswersByCard(answers.map((answer) => {
            const user = users.get(Number((participants.find((participant) => participant.id === answer.participant_id) || {}).user_id));
            return {
                ...answer,
                user_id: user?.id,
                username: user?.username || 'unknown'
            };
        }))
    };
}

async function finalizeSession({ mpPool, mainPool = null }, sessionId) {
    const session = await loadSession(mpPool, sessionId);
    if (!session || session.status === 'finished') return session;

    const participants = await loadParticipants(mpPool, sessionId);
    const winner = session.mode === 'competitive'
        ? participants.reduce((best, current) => {
            if (!best) return current;
            if ((current.score || 0) > (best.score || 0)) return current;
            if ((current.score || 0) < (best.score || 0)) return best;
            if ((current.correct_count || 0) > (best.correct_count || 0)) return current;
            if ((current.correct_count || 0) < (best.correct_count || 0)) return best;
            if ((current.total_time_ms || Number.MAX_SAFE_INTEGER) < (best.total_time_ms || Number.MAX_SAFE_INTEGER)) return current;
            return best;
        }, null)
        : null;

    await mpPool.query(
        `UPDATE multiplayer_sessions
         SET status = 'finished', finished_at = CURRENT_TIMESTAMP, winner_user_id = $2
         WHERE id = $1`,
        [sessionId, winner ? winner.user_id : null]
    );

    for (const participant of participants) {
        const winsDelta = winner && Number(winner.user_id) === Number(participant.user_id) ? 1 : 0;
        await mpPool.query(
            `INSERT INTO multiplayer_user_stats (
                user_id, wins, correct_answers, total_answers, points, total_time_ms, sessions_played, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, 1, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id) DO UPDATE SET
                wins = multiplayer_user_stats.wins + EXCLUDED.wins,
                correct_answers = multiplayer_user_stats.correct_answers + EXCLUDED.correct_answers,
                total_answers = multiplayer_user_stats.total_answers + EXCLUDED.total_answers,
                points = multiplayer_user_stats.points + EXCLUDED.points,
                total_time_ms = multiplayer_user_stats.total_time_ms + EXCLUDED.total_time_ms,
                sessions_played = multiplayer_user_stats.sessions_played + 1,
                updated_at = CURRENT_TIMESTAMP`,
            [
                participant.user_id,
                winsDelta,
                participant.correct_count,
                participant.correct_count + participant.incorrect_count,
                participant.score,
                participant.total_time_ms
            ]
        );
    }

    return loadSession(mpPool, sessionId);
}

async function broadcastSession(ctx, sessionId) {
    const { mpPool, io, mainPool = null } = ctx;
    const payload = await buildSessionPayload({ mpPool, mainPool }, sessionId);
    if (!payload) return null;
    await emitSessionToAudience(ctx, sessionId, 'multiplayer:sessionUpdated', payload);
    return payload;
}

async function emitSessionToAudience({ mpPool, io, mainPool = null }, sessionId, eventName, payload) {
    const session = await loadSession(mpPool, sessionId);
    if (!session) return;
    const participants = await loadParticipants(mpPool, sessionId);
    const audienceUserIds = [...new Set([Number(session.host_user_id), ...participants.map((participant) => Number(participant.user_id))])].filter(Boolean);
    let audience = io.to(createRoomName(sessionId));
    for (const userId of audienceUserIds) {
        audience = audience.to(`user_${userId}`);
    }
    audience.emit(eventName, payload);
}

async function advanceSessionIfNeeded(ctx, sessionId) {
    const { mpPool, io, mainPool = null } = ctx;
    const session = await loadSession(mpPool, sessionId);
    if (!session || session.status !== 'active') return session;

    const cards = Array.isArray(session.cards_snapshot) ? session.cards_snapshot : [];
    const nextIndex = Number(session.current_card_index || 0) + 1;
    if (nextIndex >= cards.length) {
        const finalized = await finalizeSession(ctx, sessionId);
        const payload = await buildSessionPayload({ mpPool, mainPool }, sessionId);
        await emitSessionToAudience(ctx, sessionId, 'multiplayer:sessionFinished', payload);
        io.emit('multiplayer:overviewUpdated', { reason: 'finished', sessionId });
        return finalized;
    }

    await mpPool.query(
        `UPDATE multiplayer_sessions
         SET current_card_index = $2, current_card_started_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [sessionId, nextIndex]
    );

    const payload = await buildSessionPayload({ mpPool, mainPool }, sessionId);
    await emitSessionToAudience(ctx, sessionId, 'multiplayer:sessionUpdated', payload);
    await emitSessionToAudience(ctx, sessionId, 'multiplayer:roundStarted', {
        sessionId,
        cardIndex: nextIndex,
        card: payload.currentCard
    });
    return loadSession(mpPool, sessionId);
}

function createAuthMiddleware(jwtSecret) {
    return (req, res, next) => {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Требуется авторизация' });
        }

        jwt.verify(token, jwtSecret, (error, user) => {
            if (error) {
                return res.status(403).json({ error: 'Неверный токен' });
            }
            req.user = user;
            next();
        });
    };
}

async function registerMultiplayer({ app, io, connectedUsers = new Map() }) {
    const mpPool = createMultiplayerPool();
    const mainPool = createMainPool();
    const jwtSecret = process.env.JWT_SECRET || 'lexy-secret-key-2024';
    const authenticateToken = createAuthMiddleware(jwtSecret);
    const context = { mpPool, io, mainPool };

    await ensureMultiplayerSchema(mpPool);

    app.get('/api/health', (_, res) => res.json({ ok: true }));

    app.get('/api/multiplayer/overview', authenticateToken, async (req, res) => {
        try {
            const statsResult = await mpPool.query(
                `SELECT user_id, wins, correct_answers, total_answers, points, sessions_played, total_time_ms,
                        COALESCE(ROUND((correct_answers::numeric / NULLIF(total_answers, 0)) * 100, 1), 0) AS accuracy
                 FROM multiplayer_user_stats
                 ORDER BY points DESC, wins DESC, correct_answers DESC, total_time_ms ASC`
            );

            const users = await fetchUsersByIds(mpPool, statsResult.rows.map((row) => row.user_id), mainPool);
            const leaderboard = statsResult.rows.map((row, index) => {
                const user = users.get(Number(row.user_id));
                return {
                    position: index + 1,
                    user_id: row.user_id,
                    username: user?.username || 'unknown',
                    name: user?.name || 'Пользователь',
                    avatar: user?.avatar || '👤',
                    wins: row.wins,
                    correct_answers: row.correct_answers,
                    total_answers: row.total_answers,
                    points: row.points,
                    sessions_played: row.sessions_played,
                    total_time_ms: row.total_time_ms,
                    accuracy: row.accuracy
                };
            });

            const myStats = statsResult.rows.find((row) => Number(row.user_id) === Number(req.user.id)) || {
                wins: 0,
                correct_answers: 0,
                total_answers: 0,
                points: 0,
                sessions_played: 0,
                total_time_ms: 0,
                accuracy: 0
            };
            const myPosition = leaderboard.find((row) => Number(row.user_id) === Number(req.user.id));

            const historyResult = await mpPool.query(
                `SELECT s.*
                 FROM multiplayer_sessions s
                 JOIN multiplayer_session_participants p ON p.session_id = s.id
                 WHERE p.user_id = $1
                 ORDER BY s.created_at DESC
                 LIMIT 20`,
                [req.user.id]
            );

            const activeResult = await mpPool.query(
                `SELECT s.id,
                    s.code,
                    s.mode,
                    s.input_mode,
                    s.status,
                    s.created_at,
                    s.started_at,
                    s.finished_at,
                    s.deck_id,
                    s.host_user_id,
                    u.username AS host_username,
                    u.name AS host_name
                 FROM multiplayer_sessions s
                 LEFT JOIN multiplayer_users u ON u.id = s.host_user_id
                 WHERE s.status IN ('waiting', 'active')
                 ORDER BY s.created_at DESC
                 LIMIT 12`
            );

            const deckIds = [...historyResult.rows.map((row) => row.deck_id), ...activeResult.rows.map((row) => row.deck_id)];
            const decks = await fetchDecksByIds(mpPool, deckIds);

            const summarizeSession = async (sessionRow) => {
                const participants = await loadParticipants(mpPool, sessionRow.id, { activeOnly: false });
                const participantUsers = await fetchUsersByIds(mpPool, participants.map((participant) => participant.user_id), mainPool);
                return {
                    id: sessionRow.id,
                    code: sessionRow.code,
                    mode: sessionRow.mode,
                    input_mode: sessionRow.input_mode,
                    status: sessionRow.status,
                    created_at: sessionRow.created_at,
                    started_at: sessionRow.started_at,
                    finished_at: sessionRow.finished_at,
                    deck_id: sessionRow.deck_id,
                    deck_name: decks.get(Number(sessionRow.deck_id))?.name || 'Колода',
                    winner_user_id: sessionRow.winner_user_id,
                    participants: participants.map((participant) => {
                        const user = participantUsers.get(Number(participant.user_id));
                        return {
                            id: participant.id,
                            userId: participant.user_id,
                            username: user?.username || 'unknown',
                            name: user?.name || 'Пользователь',
                            correctCount: participant.correct_count,
                            incorrectCount: participant.incorrect_count,
                            totalTimeMs: participant.total_time_ms,
                            score: participant.score,
                            status: participant.status
                        };
                    })
                };
            };

            const history = [];
            for (const session of historyResult.rows) history.push(await summarizeSession(session));

            res.json({
                me: {
                    ...myStats,
                    position: myPosition?.position || null
                },
                leaderboard,
                history,
                activeSessions: activeResult.rows.map((session) => ({
                    id: session.id,
                    code: session.code,
                    mode: session.mode,
                    input_mode: session.input_mode,
                    status: session.status,
                    created_at: session.created_at,
                    deck_id: session.deck_id,
                    deck_name: decks.get(Number(session.deck_id))?.name || 'Колода',
                    host_user_id: session.host_user_id,
                    host_username: session.host_username,
                    host_name: session.host_name
                }))
            });
        } catch (error) {
            console.error('multiplayer overview error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.get('/api/multiplayer/invites', authenticateToken, async (req, res) => {
        try {
            const result = await mpPool.query(
                `SELECT i.*, s.code AS session_code, s.mode, s.input_mode, s.status AS session_status, s.deck_id
                 FROM multiplayer_session_invites i
                 JOIN multiplayer_sessions s ON s.id = i.session_id
                 WHERE i.invitee_user_id = $1 AND i.status = 'pending'
                 ORDER BY i.created_at DESC`,
                [req.user.id]
            );

            const decks = await fetchDecksByIds(mpPool, result.rows.map((row) => row.deck_id));
            const users = await fetchUsersByIds(mpPool, result.rows.map((row) => row.inviter_user_id), mainPool);

            res.json({
                invites: result.rows.map((invite) => ({
                    id: invite.id,
                    session_id: invite.session_id,
                    inviter_user_id: invite.inviter_user_id,
                    invitee_user_id: invite.invitee_user_id,
                    invitee_username: invite.invitee_username,
                    status: invite.status,
                    created_at: invite.created_at,
                    sessionCode: invite.session_code,
                    deckName: decks.get(Number(invite.deck_id))?.name || 'Колода',
                    mode: invite.mode,
                    inputMode: invite.input_mode,
                    sessionStatus: invite.session_status,
                    inviterUsername: users.get(Number(invite.inviter_user_id))?.username || 'unknown',
                    inviterName: users.get(Number(invite.inviter_user_id))?.name || 'Пользователь'
                }))
            });
        } catch (error) {
            console.error('multiplayer invites error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.post('/api/multiplayer/sessions', authenticateToken, async (req, res) => {
        const client = await mpPool.connect();
        try {
            const { deckId, mode = 'competitive', inputMode = 'buttons' } = req.body;
            console.log('Creating session for user:', req.user.id, 'deckId:', deckId);

            // Sync user and deck first
            const user = await syncUser(mpPool, req.user.id, req.headers.authorization.split(' ')[1]);
            if (!user) {
                console.log('Failed to sync user');
                return res.status(500).json({ error: 'Не удалось синхронизировать пользователя' });
            }
            const deckData = await syncDeck(mpPool, deckId, req.headers.authorization.split(' ')[1]);
            if (!deckData) {
                console.log('Failed to sync deck');
                return res.status(403).json({ error: 'Не удалось синхронизировать колоду или она недоступна' });
            }

            const deck = await fetchOwnedDeck(mpPool, req.user.id, deckId);
            if (!deck) {
                return res.status(403).json({ error: 'Колода недоступна' });
            }

            const cards = await fetchDeckCards(mpPool, deckId);
            if (cards.length === 0) {
                return res.status(400).json({ error: 'В колоде нет карточек' });
            }

            let code = generateSessionCode();
            let codeCheck = await client.query('SELECT id FROM multiplayer_sessions WHERE code = $1', [code]);
            while (codeCheck.rows.length > 0) {
                code = generateSessionCode();
                codeCheck = await client.query('SELECT id FROM multiplayer_sessions WHERE code = $1', [code]);
            }

            await client.query('BEGIN');
            const sessionResult = await client.query(
                `INSERT INTO multiplayer_sessions (
                    code, host_user_id, deck_id, mode, input_mode, status, cards_snapshot
                 ) VALUES ($1, $2, $3, $4, $5, 'waiting', $6)
                 RETURNING *`,
                [code, req.user.id, deckId, mode, inputMode, JSON.stringify(cards)]
            );

            const session = sessionResult.rows[0];
            await client.query(
                `INSERT INTO multiplayer_session_participants (session_id, user_id, status)
                 VALUES ($1, $2, 'active')`,
                [session.id, req.user.id]
            );
            await client.query('COMMIT');

            const payload = await buildSessionPayload(context, session.id, req.user.id);
            io.emit('multiplayer:overviewUpdated', { reason: 'created', sessionId: session.id });
            res.status(201).json({ session: payload });
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('multiplayer create session error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        } finally {
            client.release();
        }
    });

    app.post('/api/multiplayer/sessions/join', authenticateToken, async (req, res) => {
        try {
            const code = (req.body.code || '').toString().trim().toUpperCase();
            const sessionResult = await mpPool.query('SELECT * FROM multiplayer_sessions WHERE code = $1', [code]);
            if (sessionResult.rows.length === 0) {
                return res.status(404).json({ error: 'Сессия не найдена' });
            }

            const session = sessionResult.rows[0];
            if (session.status === 'finished') {
                return res.status(400).json({ error: 'Сессия уже завершена' });
            }

            const participantCheck = await mpPool.query(
                'SELECT id FROM multiplayer_session_participants WHERE session_id = $1 AND user_id = $2',
                [session.id, req.user.id]
            );

            if (participantCheck.rows.length === 0) {
                if (session.status !== 'waiting') {
                    return res.status(400).json({ error: 'Сессия уже запущена' });
                }

                await mpPool.query(
                    `INSERT INTO multiplayer_session_participants (session_id, user_id, status)
                     VALUES ($1, $2, 'active')`,
                    [session.id, req.user.id]
                );
            } else {
                await mpPool.query(
                    `UPDATE multiplayer_session_participants
                     SET status = 'active', last_seen_at = CURRENT_TIMESTAMP
                     WHERE session_id = $1 AND user_id = $2`,
                    [session.id, req.user.id]
                );
            }

            // Keep the joining user's profile fresh
            const token = req.headers.authorization?.split(' ')[1];
            if (token) {
                await syncUser(mpPool, req.user.id, token);
            }

            const payload = await buildSessionPayload(context, session.id, req.user.id);
            io.emit('multiplayer:overviewUpdated', { reason: 'joined', sessionId: session.id });
            await emitSessionToAudience(context, session.id, 'multiplayer:sessionUpdated', payload);
            res.json({ session: payload });
        } catch (error) {
            console.error('multiplayer join error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.delete('/api/multiplayer/sessions/:id', authenticateToken, async (req, res) => {
        try {
            const sessionId = Number(req.params.id);
            if (!sessionId) {
                return res.status(400).json({ error: 'Некорректный идентификатор сессии' });
            }

            const session = await loadSession(mpPool, sessionId);
            if (!session) {
                return res.status(404).json({ error: 'Сессия не найдена' });
            }

            const isHost = Number(session.host_user_id) === Number(req.user.id);
            const isAdmin = req.user?.role === 'admin';
            if (!isHost && !isAdmin) {
                return res.status(403).json({ error: 'Доступ запрещён' });
            }

            const participants = await loadParticipants(mpPool, sessionId);
            const audienceUserIds = [...new Set([Number(session.host_user_id), ...participants.map((participant) => Number(participant.user_id))])].filter(Boolean);
            let audience = io.to(createRoomName(sessionId));
            for (const userId of audienceUserIds) {
                audience = audience.to(`user_${userId}`);
            }

            await mpPool.query('BEGIN');
            await mpPool.query('DELETE FROM multiplayer_session_answers WHERE session_id = $1', [sessionId]);
            await mpPool.query('DELETE FROM multiplayer_session_invites WHERE session_id = $1', [sessionId]);
            await mpPool.query('DELETE FROM multiplayer_session_participants WHERE session_id = $1', [sessionId]);
            await mpPool.query('DELETE FROM multiplayer_sessions WHERE id = $1', [sessionId]);
            await mpPool.query('COMMIT');

            audience.emit('multiplayer:sessionDeleted', {
                sessionId,
                code: session.code
            });
            io.emit('multiplayer:overviewUpdated', { reason: 'deleted', sessionId });

            res.json({ deleted: true, sessionId });
        } catch (error) {
            await mpPool.query('ROLLBACK').catch(() => {});
            console.error('multiplayer delete session error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.post('/api/multiplayer/sessions/:id/leave', authenticateToken, async (req, res) => {
        try {
            const sessionId = Number(req.params.id);
            if (!sessionId) {
                return res.status(400).json({ error: 'Некорректный идентификатор сессии' });
            }

            const session = await loadSession(mpPool, sessionId);
            if (!session) {
                return res.status(404).json({ error: 'Сессия не найдена' });
            }

            if (Number(session.host_user_id) === Number(req.user.id)) {
                return res.status(400).json({ error: 'Создатель сессии должен удалять лобби через удаление комнаты' });
            }

            const participant = await mpPool.query(
                'SELECT id FROM multiplayer_session_participants WHERE session_id = $1 AND user_id = $2',
                [sessionId, req.user.id]
            );
            if (participant.rows.length === 0) {
                return res.status(404).json({ error: 'Участник не найден' });
            }

            await mpPool.query(
                `UPDATE multiplayer_session_participants
                 SET status = 'left', last_seen_at = CURRENT_TIMESTAMP
                 WHERE session_id = $1 AND user_id = $2`,
                [sessionId, req.user.id]
            );

            const payload = await buildSessionPayload(context, sessionId);
            await emitSessionToAudience(context, sessionId, 'multiplayer:sessionUpdated', payload);
            io.emit('multiplayer:overviewUpdated', { reason: 'left', sessionId });

            res.json({ left: true, session: payload });
        } catch (error) {
            console.error('multiplayer leave session error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.post('/api/multiplayer/sessions/:id/invites', authenticateToken, async (req, res) => {
        try {
            const sessionId = Number(req.params.id);
            const username = (req.body.username || '').toString().trim();
            const session = await loadSession(mpPool, sessionId);
            if (!session || Number(session.host_user_id) !== Number(req.user.id)) {
                return res.status(403).json({ error: 'Доступ запрещён' });
            }

            const targetUser = await findUserByUsername(username, req.headers.authorization.split(' ')[1]);
            if (!targetUser) {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }

            // Sync invited user
            const syncedUser = await syncUser(mpPool, targetUser.id, req.headers.authorization.split(' ')[1]);
            if (!syncedUser) {
                return res.status(500).json({ error: 'Не удалось синхронизировать пользователя' });
            }

            const inviteResult = await mpPool.query(
                `INSERT INTO multiplayer_session_invites (
                    session_id, inviter_user_id, invitee_user_id, invitee_username, status
                ) VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
                [sessionId, req.user.id, targetUser.id, targetUser.username]
            );

            const inviteId = inviteResult.rows[0].id;

            const inviter = await fetchUser(mpPool, req.user.id);
            const payload = {
                id: inviteId,
                sessionId,
                sessionCode: session.code,
                deckName: (await fetchDeck(mpPool, session.deck_id))?.name || 'Колода',
                mode: session.mode,
                inputMode: session.input_mode,
                inviterUsername: inviter?.username || 'unknown',
                inviterName: inviter?.name || 'Пользователь'
            };

            io.to(`user_${targetUser.id}`).emit('multiplayer:invite', payload);
            res.status(201).json({ invite: payload });
        } catch (error) {
            console.error('multiplayer invite error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.post('/api/multiplayer/invites/:id/respond', authenticateToken, async (req, res) => {
        try {
            const inviteId = Number(req.params.id);
            const action = (req.body.action || '').toString();
            const inviteResult = await mpPool.query('SELECT * FROM multiplayer_session_invites WHERE id = $1', [inviteId]);
            if (inviteResult.rows.length === 0) {
                return res.status(404).json({ error: 'Приглашение не найдено' });
            }

            const invite = inviteResult.rows[0];
            if (Number(invite.invitee_user_id) !== Number(req.user.id)) {
                return res.status(403).json({ error: 'Доступ запрещён' });
            }

            // Block finished sessions
            const invitedSession = await loadSession(mpPool, invite.session_id);
            if (!invitedSession || invitedSession.status === 'finished') {
                return res.status(400).json({ error: 'Сессия уже завершена' });
            }

            await mpPool.query(
                `UPDATE multiplayer_session_invites
                 SET status = $1, responded_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [action === 'accept' ? 'accepted' : 'declined', inviteId]
            );

            if (action === 'accept') {
                const participantCheck = await mpPool.query(
                    'SELECT id FROM multiplayer_session_participants WHERE session_id = $1 AND user_id = $2',
                    [invite.session_id, req.user.id]
                );
                if (participantCheck.rows.length === 0) {
                    await mpPool.query(
                        `INSERT INTO multiplayer_session_participants (session_id, user_id, status)
                         VALUES ($1, $2, 'active')`,
                        [invite.session_id, req.user.id]
                    );
                }
            }

            // Refresh the accepting user's profile
            const token = req.headers.authorization?.split(' ')[1];
            if (token) {
                await syncUser(mpPool, req.user.id, token);
            }

            const payload = await buildSessionPayload(context, invite.session_id, req.user.id);
            io.emit('multiplayer:overviewUpdated', { reason: action === 'accept' ? 'joined' : 'invite-responded', sessionId: invite.session_id });
            await emitSessionToAudience(context, invite.session_id, 'multiplayer:sessionUpdated', payload);
            res.json({ inviteId, action, session: payload });
        } catch (error) {
            console.error('multiplayer invite respond error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.post('/api/multiplayer/sessions/:id/start', authenticateToken, async (req, res) => {
        try {
            const sessionId = Number(req.params.id);
            const session = await loadSession(mpPool, sessionId);
            if (!session || Number(session.host_user_id) !== Number(req.user.id)) {
                return res.status(403).json({ error: 'Доступ запрещён' });
            }

            const participants = await loadParticipants(mpPool, sessionId);
            if (participants.filter((participant) => participant.status === 'active').length < 2) {
                return res.status(400).json({ error: 'Нужно минимум два участника' });
            }

            await mpPool.query(
                `UPDATE multiplayer_sessions
                 SET status = 'active', started_at = CURRENT_TIMESTAMP, current_card_index = 0, current_card_started_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [sessionId]
            );

            const payload = await broadcastSession(context, sessionId);
            io.emit('multiplayer:overviewUpdated', { reason: 'started', sessionId });
            await emitSessionToAudience(context, sessionId, 'multiplayer:roundStarted', {
                sessionId,
                cardIndex: 0,
                card: payload?.currentCard || null
            });

            res.json({ session: payload });
        } catch (error) {
            console.error('multiplayer start error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.get('/api/multiplayer/sessions/:id', authenticateToken, async (req, res) => {
        try {
            const payload = await buildSessionPayload(context, Number(req.params.id), req.user.id);
            if (!payload) return res.status(404).json({ error: 'Сессия не найдена' });
            res.json({ session: payload });
        } catch (error) {
            console.error('multiplayer session fetch error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.post('/api/multiplayer/sessions/:id/answer', authenticateToken, async (req, res) => {
        try {
            const sessionId = Number(req.params.id);
            const answerText = (req.body.answer || '').toString();
            const session = await loadSession(mpPool, sessionId);
            if (!session || session.status !== 'active') {
                return res.status(400).json({ error: 'Сессия не активна' });
            }

            const participantResult = await mpPool.query(
                'SELECT * FROM multiplayer_session_participants WHERE session_id = $1 AND user_id = $2',
                [sessionId, req.user.id]
            );
            if (participantResult.rows.length === 0) {
                return res.status(403).json({ error: 'Пользователь не участвует в сессии' });
            }

            const participant = participantResult.rows[0];
            const cards = Array.isArray(session.cards_snapshot) ? session.cards_snapshot : [];
            const currentCard = cards[session.current_card_index];
            if (!currentCard) {
                return res.status(400).json({ error: 'Карточка не найдена' });
            }

            const duplicate = await mpPool.query(
                `SELECT id FROM multiplayer_session_answers
                 WHERE session_id = $1 AND participant_id = $2 AND card_index = $3`,
                [sessionId, participant.id, session.current_card_index]
            );
            if (duplicate.rows.length > 0) {
                return res.status(400).json({ error: 'Ответ уже отправлен' });
            }

            const responseMs = session.current_card_started_at ? Math.max(0, Date.now() - new Date(session.current_card_started_at).getTime()) : 0;
            let isCorrect = false;
            if (session.input_mode === 'text') {
                const normalizedAnswer = normalizeText(answerText);
                const candidates = [];
                if (currentCard.back) candidates.push(currentCard.back);
                if (currentCard.translation) candidates.push(currentCard.translation);
                // Split common delimiters into alternatives
                const extras = candidates.slice().flatMap(c => (c || '').split(/[;|\/\\,]/).map(s => s.trim()).filter(Boolean));
                const allCandidates = [...candidates, ...extras];
                const normalizedCandidates = allCandidates.map(normalizeText);
                isCorrect = normalizedCandidates.includes(normalizedAnswer);
            } else {
                isCorrect = normalizeText(answerText) === 'know';
            }
            const scoreDelta = session.mode === 'competitive'
                ? (isCorrect ? Math.max(25, 1000 - Math.floor(responseMs / 12)) : 0)
                : (isCorrect ? 1 : 0);

            await mpPool.query('BEGIN');
            await mpPool.query(
                `INSERT INTO multiplayer_session_answers (
                    session_id, participant_id, card_index, answer_text, is_correct, response_ms
                 ) VALUES ($1, $2, $3, $4, $5, $6)`,
                [sessionId, participant.id, session.current_card_index, answerText, isCorrect, responseMs]
            );
            await mpPool.query(
                `UPDATE multiplayer_session_participants
                 SET correct_count = correct_count + $1,
                     incorrect_count = incorrect_count + $2,
                     total_time_ms = total_time_ms + $3,
                     score = score + $4,
                     last_seen_at = CURRENT_TIMESTAMP
                 WHERE id = $5`,
                [isCorrect ? 1 : 0, isCorrect ? 0 : 1, responseMs, scoreDelta, participant.id]
            );
            await mpPool.query('COMMIT');

            const participants = await loadParticipants(mpPool, sessionId);
            const activeParticipants = participants.filter((item) => item.status === 'active');
            const answers = await loadAnswers(mpPool, sessionId);
            const currentAnswers = answers.filter((answer) => Number(answer.card_index) === Number(session.current_card_index));
            const participantUserIds = new Map(participants.map((participant) => [Number(participant.id), Number(participant.user_id)]));
            const roundUsers = await fetchUsersByIds(mpPool, [req.user.id, ...participants.map((participant) => participant.user_id)], mainPool);

            const payload = await buildSessionPayload(context, sessionId, req.user.id);
            await emitSessionToAudience(context, sessionId, 'multiplayer:roundResult', {
                session: payload,
                currentAnswer: {
                    userId: req.user.id,
                    username: roundUsers.get(Number(req.user.id))?.username || req.user.username,
                    isCorrect,
                    responseMs,
                    scoreDelta
                },
                roundResults: currentAnswers.map((answer) => ({
                    userId: participantUserIds.get(Number(answer.participant_id)) || null,
                    username: roundUsers.get(Number(participantUserIds.get(Number(answer.participant_id))))?.username || 'unknown',
                    isCorrect: answer.is_correct,
                    responseMs: answer.response_ms
                })),
                allAnswered: currentAnswers.length >= activeParticipants.length
            });

            if (currentAnswers.length >= activeParticipants.length) {
                await advanceSessionIfNeeded(context, sessionId);
            } else {
                await broadcastSession(context, sessionId);
            }

            res.json({
                ok: true,
                isCorrect,
                responseMs,
                scoreDelta,
                session: await buildSessionPayload(context, sessionId, req.user.id),
                allAnswered: currentAnswers.length >= activeParticipants.length
            });
        } catch (error) {
            await mpPool.query('ROLLBACK').catch(() => {});
            console.error('multiplayer answer error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.get('/api/multiplayer/leaderboard', authenticateToken, async (req, res) => {
        try {
            const result = await mpPool.query(
                `SELECT user_id, wins, correct_answers, total_answers, points, sessions_played, total_time_ms,
                        COALESCE(ROUND((correct_answers::numeric / NULLIF(total_answers, 0)) * 100, 1), 0) AS accuracy
                 FROM multiplayer_user_stats
                 ORDER BY points DESC, wins DESC, correct_answers DESC, total_time_ms ASC
                 LIMIT 50`
            );

            const users = await fetchUsersByIds(mpPool, result.rows.map((row) => row.user_id), mainPool);
            res.json({
                leaderboard: result.rows.map((row, index) => ({
                    position: index + 1,
                    user_id: row.user_id,
                    username: users.get(Number(row.user_id))?.username || 'unknown',
                    name: users.get(Number(row.user_id))?.name || 'Пользователь',
                    avatar: users.get(Number(row.user_id))?.avatar || '👤',
                    wins: row.wins,
                    correct_answers: row.correct_answers,
                    total_answers: row.total_answers,
                    points: row.points,
                    sessions_played: row.sessions_played,
                    total_time_ms: row.total_time_ms,
                    accuracy: row.accuracy
                }))
            });
        } catch (error) {
            console.error('multiplayer leaderboard error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.get('/api/multiplayer/history', authenticateToken, async (req, res) => {
        try {
            const sessions = await mpPool.query(
                `SELECT s.*
                 FROM multiplayer_sessions s
                 JOIN multiplayer_session_participants p ON p.session_id = s.id
                 WHERE p.user_id = $1
                 ORDER BY s.created_at DESC`,
                [req.user.id]
            );
            const decks = await fetchDecksByIds(mpPool, sessions.rows.map((row) => row.deck_id));
            const history = [];
            for (const session of sessions.rows) {
                const participants = await loadParticipants(mpPool, session.id);
                const userMap = await fetchUsersByIds(mpPool, participants.map((participant) => participant.user_id), mainPool);
                history.push({
                    id: session.id,
                    code: session.code,
                    mode: session.mode,
                    input_mode: session.input_mode,
                    status: session.status,
                    created_at: session.created_at,
                    started_at: session.started_at,
                    finished_at: session.finished_at,
                    deck_id: session.deck_id,
                    deck_name: decks.get(Number(session.deck_id))?.name || 'Колода',
                    winner_user_id: session.winner_user_id,
                    participants: participants.map((participant) => {
                        const user = userMap.get(Number(participant.user_id));
                        return {
                            id: participant.id,
                            userId: participant.user_id,
                            username: user?.username || 'unknown',
                            name: user?.name || 'Пользователь',
                            correctCount: participant.correct_count,
                            incorrectCount: participant.incorrect_count,
                            totalTimeMs: participant.total_time_ms,
                            score: participant.score,
                            status: participant.status
                        };
                    })
                });
            }

            res.json({ history });
        } catch (error) {
            console.error('multiplayer history error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    io.on('connection', (socket) => {
        const userId = Number(socket.data?.userId);
        if (userId) {
            socket.join(`user_${userId}`);
            connectedUsers.set(userId, socket.id);
        }

        socket.on('multiplayer:joinRoom', async ({ sessionId }) => {
            const numericSessionId = Number(sessionId);
            if (!numericSessionId || !userId) return;
            const payload = await buildSessionPayload(context, numericSessionId, userId);
            if (!payload) return;
            socket.join(createRoomName(numericSessionId));
            socket.emit('multiplayer:sessionState', payload);
        });

        socket.on('multiplayer:leaveRoom', ({ sessionId }) => {
            const numericSessionId = Number(sessionId);
            if (!numericSessionId) return;
            socket.leave(createRoomName(numericSessionId));
        });

        socket.on('disconnect', () => {
            if (userId && connectedUsers.get(userId) === socket.id) {
                connectedUsers.delete(userId);
            }
        });
    });

    return { mpPool };
}

module.exports = {
    registerMultiplayer,
    ensureMultiplayerSchema,
    buildSessionPayload,
    finalizeSession,
    advanceSessionIfNeeded
};