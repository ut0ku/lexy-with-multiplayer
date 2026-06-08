const crypto = require('crypto');

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

async function ensureMultiplayerSchema(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS multiplayer_sessions (
            id SERIAL PRIMARY KEY,
            code VARCHAR(16) UNIQUE NOT NULL,
            host_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            deck_id INTEGER REFERENCES decks(id) ON DELETE CASCADE,
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
            winner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS multiplayer_session_participants (
            id SERIAL PRIMARY KEY,
            session_id INTEGER REFERENCES multiplayer_sessions(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
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

    await pool.query(`
        CREATE TABLE IF NOT EXISTS multiplayer_session_invites (
            id SERIAL PRIMARY KEY,
            session_id INTEGER REFERENCES multiplayer_sessions(id) ON DELETE CASCADE,
            inviter_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            invitee_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            invitee_username VARCHAR(50) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            responded_at TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS multiplayer_session_answers (
            id SERIAL PRIMARY KEY,
            session_id INTEGER REFERENCES multiplayer_sessions(id) ON DELETE CASCADE,
            participant_id INTEGER REFERENCES multiplayer_session_participants(id) ON DELETE CASCADE,
            card_index INTEGER NOT NULL,
            answer_text TEXT,
            is_correct BOOLEAN NOT NULL DEFAULT FALSE,
            response_ms INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(session_id, participant_id, card_index)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS multiplayer_user_stats (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            wins INTEGER NOT NULL DEFAULT 0,
            correct_answers INTEGER NOT NULL DEFAULT 0,
            total_answers INTEGER NOT NULL DEFAULT 0,
            points INTEGER NOT NULL DEFAULT 0,
            total_time_ms INTEGER NOT NULL DEFAULT 0,
            sessions_played INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

async function loadSessionById(pool, sessionId) {
    const result = await pool.query(
        `SELECT s.*, u.username AS host_username, u.name AS host_name, d.name AS deck_name
         FROM multiplayer_sessions s
         LEFT JOIN users u ON s.host_user_id = u.id
         LEFT JOIN decks d ON s.deck_id = d.id
         WHERE s.id = $1`,
        [sessionId]
    );
    return result.rows[0] || null;
}

async function loadParticipants(pool, sessionId) {
    const result = await pool.query(
        `SELECT p.id, p.session_id, p.user_id, p.status, p.joined_at, p.last_seen_at,
                p.correct_count, p.incorrect_count, p.total_time_ms, p.score,
                u.username, u.name, u.avatar
         FROM multiplayer_session_participants p
         JOIN users u ON u.id = p.user_id
         WHERE p.session_id = $1
         ORDER BY p.joined_at ASC, p.id ASC`,
        [sessionId]
    );
    return result.rows;
}

async function loadAnswers(pool, sessionId) {
    const result = await pool.query(
        `SELECT a.card_index, a.participant_id, a.answer_text, a.is_correct, a.response_ms,
                p.user_id, u.username
         FROM multiplayer_session_answers a
         JOIN multiplayer_session_participants p ON p.id = a.participant_id
         JOIN users u ON u.id = p.user_id
         WHERE a.session_id = $1
         ORDER BY a.card_index ASC, a.created_at ASC`,
        [sessionId]
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

async function buildSessionPayload(pool, sessionId, viewerUserId = null) {
    const session = await loadSessionById(pool, sessionId);
    if (!session) return null;

    const participants = await loadParticipants(pool, sessionId);
    const answers = await loadAnswers(pool, sessionId);
    const cards = Array.isArray(session.cards_snapshot) ? session.cards_snapshot : [];
    const currentCard = cards[session.current_card_index] || null;

    const participantIds = participants.map((participant) => participant.user_id);
    if (viewerUserId !== null && !participantIds.includes(viewerUserId) && Number(session.host_user_id) !== Number(viewerUserId)) {
        return null;
    }

    return {
        session: {
            id: session.id,
            code: session.code,
            hostUserId: session.host_user_id,
            hostUsername: session.host_username,
            hostName: session.host_name,
            deckId: session.deck_id,
            deckName: session.deck_name,
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
        participants: participants.map((participant) => ({
            id: participant.id,
            userId: participant.user_id,
            username: participant.username,
            name: participant.name,
            avatar: participant.avatar,
            status: participant.status,
            joinedAt: participant.joined_at,
            correctCount: participant.correct_count,
            incorrectCount: participant.incorrect_count,
            totalTimeMs: participant.total_time_ms,
            score: participant.score
        })),
        currentCard,
        cards,
        answersByCard: groupAnswersByCard(answers)
    };
}

async function updateLeaderboard(pool, sessionId, winnerUserId = null) {
    const participants = await loadParticipants(pool, sessionId);
    for (const participant of participants) {
        const pointsDelta = participant.score || 0;
        const winsDelta = winnerUserId && Number(winnerUserId) === Number(participant.user_id) ? 1 : 0;
        await pool.query(
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
                pointsDelta,
                participant.total_time_ms
            ]
        );
    }
}

function determineWinner(participants) {
    return participants.reduce((best, current) => {
        if (!best) return current;
        if ((current.score || 0) > (best.score || 0)) return current;
        if ((current.score || 0) < (best.score || 0)) return best;
        if ((current.correct_count || 0) > (best.correct_count || 0)) return current;
        if ((current.correct_count || 0) < (best.correct_count || 0)) return best;
        if ((current.total_time_ms || Number.MAX_SAFE_INTEGER) < (best.total_time_ms || Number.MAX_SAFE_INTEGER)) return current;
        return best;
    }, null);
}

async function finalizeSession(pool, sessionId) {
    const session = await loadSessionById(pool, sessionId);
    if (!session || session.status === 'finished') {
        return session;
    }

    const participants = await loadParticipants(pool, sessionId);
    const winner = session.mode === 'competitive' ? determineWinner(participants) : null;
    const winnerUserId = winner ? winner.user_id : null;

    await pool.query(
        `UPDATE multiplayer_sessions
         SET status = 'finished', finished_at = CURRENT_TIMESTAMP, winner_user_id = $2
         WHERE id = $1`,
        [sessionId, winnerUserId]
    );

    await updateLeaderboard(pool, sessionId, winnerUserId);

    return loadSessionById(pool, sessionId);
}

async function advanceSessionIfNeeded(pool, io, sessionId) {
    const session = await loadSessionById(pool, sessionId);
    if (!session || session.status !== 'active') return session;

    const cards = Array.isArray(session.cards_snapshot) ? session.cards_snapshot : [];
    const nextIndex = Number(session.current_card_index || 0) + 1;

    if (nextIndex >= cards.length) {
        const finalized = await finalizeSession(pool, sessionId);
        const payload = await buildSessionPayload(pool, sessionId);
        io.to(createRoomName(sessionId)).emit('multiplayer:sessionFinished', payload);
        return finalized;
    }

    await pool.query(
        `UPDATE multiplayer_sessions
         SET current_card_index = $2, current_card_started_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [sessionId, nextIndex]
    );

    const payload = await buildSessionPayload(pool, sessionId);
    io.to(createRoomName(sessionId)).emit('multiplayer:sessionUpdated', payload);
    io.to(createRoomName(sessionId)).emit('multiplayer:roundStarted', {
        sessionId,
        cardIndex: nextIndex,
        card: payload.currentCard
    });
    return loadSessionById(pool, sessionId);
}

async function emitSessionSnapshot(pool, io, sessionId) {
    const payload = await buildSessionPayload(pool, sessionId);
    if (!payload) return null;
    io.to(createRoomName(sessionId)).emit('multiplayer:sessionUpdated', payload);
    return payload;
}

function canViewSession(session, userId, participantIds) {
    return Number(session.host_user_id) === Number(userId) || participantIds.includes(Number(userId));
}

async function registerMultiplayer({ app, pool, io, authenticateToken, connectedUsers }) {
    await ensureMultiplayerSchema(pool);

    const findAccessibleSession = async (sessionId, userId) => {
        const session = await loadSessionById(pool, sessionId);
        if (!session) return null;
        const participants = await loadParticipants(pool, sessionId);
        const participantIds = participants.map((participant) => Number(participant.user_id));
        if (!canViewSession(session, userId, participantIds)) return null;
        return { session, participants };
    };

    app.get('/api/multiplayer/overview', authenticateToken, async (req, res) => {
        try {
            const stats = await pool.query(
                `SELECT COALESCE(us.wins, 0) AS wins,
                        COALESCE(us.correct_answers, 0) AS correct_answers,
                        COALESCE(us.total_answers, 0) AS total_answers,
                        COALESCE(us.points, 0) AS points,
                        COALESCE(us.sessions_played, 0) AS sessions_played,
                        COALESCE(us.total_time_ms, 0) AS total_time_ms,
                        COALESCE(ROUND((us.correct_answers::numeric / NULLIF(us.total_answers, 0)) * 100, 1), 0) AS accuracy,
                        ranked.position
                 FROM users u
                 LEFT JOIN multiplayer_user_stats us ON us.user_id = u.id
                 LEFT JOIN (
                    SELECT user_id, ROW_NUMBER() OVER (ORDER BY points DESC, wins DESC, correct_answers DESC, total_time_ms ASC) AS position
                    FROM multiplayer_user_stats
                 ) ranked ON ranked.user_id = u.id
                 WHERE u.id = $1`,
                [req.user.id]
            );

            const leaderboard = await pool.query(
                `SELECT ranked.position,
                        ranked.user_id,
                        ranked.username,
                        ranked.name,
                        ranked.avatar,
                        ranked.wins,
                        ranked.correct_answers,
                        ranked.total_answers,
                        ranked.points,
                        ranked.sessions_played,
                        ranked.total_time_ms,
                        ranked.accuracy
                 FROM (
                    SELECT u.id AS user_id,
                           u.username,
                           u.name,
                           u.avatar,
                           COALESCE(us.wins, 0) AS wins,
                           COALESCE(us.correct_answers, 0) AS correct_answers,
                           COALESCE(us.total_answers, 0) AS total_answers,
                           COALESCE(us.points, 0) AS points,
                           COALESCE(us.sessions_played, 0) AS sessions_played,
                           COALESCE(us.total_time_ms, 0) AS total_time_ms,
                           COALESCE(ROUND((us.correct_answers::numeric / NULLIF(us.total_answers, 0)) * 100, 1), 0) AS accuracy,
                           ROW_NUMBER() OVER (ORDER BY COALESCE(us.points, 0) DESC, COALESCE(us.wins, 0) DESC, COALESCE(us.correct_answers, 0) DESC, COALESCE(us.total_time_ms, 0) ASC) AS position
                    FROM users u
                    LEFT JOIN multiplayer_user_stats us ON us.user_id = u.id
                 ) ranked
                 ORDER BY ranked.position
                 LIMIT 20`
            );

            const history = await pool.query(
                `SELECT s.id,
                        s.code,
                        s.mode,
                        s.input_mode,
                        s.status,
                        s.created_at,
                        s.started_at,
                        s.finished_at,
                        s.deck_id,
                        d.name AS deck_name,
                        s.winner_user_id,
                        COALESCE(json_agg(json_build_object(
                            'id', p.id,
                            'userId', p.user_id,
                            'username', u.username,
                            'name', u.name,
                            'correctCount', p.correct_count,
                            'incorrectCount', p.incorrect_count,
                            'totalTimeMs', p.total_time_ms,
                            'score', p.score,
                            'status', p.status
                        ) ORDER BY p.joined_at ASC) FILTER (WHERE p.id IS NOT NULL), '[]') AS participants
                 FROM multiplayer_sessions s
                 JOIN multiplayer_session_participants p ON p.session_id = s.id
                 JOIN users u ON u.id = p.user_id
                 LEFT JOIN decks d ON d.id = s.deck_id
                 WHERE p.user_id = $1
                 GROUP BY s.id, d.name
                 ORDER BY s.created_at DESC
                 LIMIT 20`,
                [req.user.id]
            );

            const recentSessions = await pool.query(
                `SELECT s.id,
                        s.code,
                        s.mode,
                        s.input_mode,
                        s.status,
                        s.created_at,
                        s.started_at,
                        s.finished_at,
                        s.deck_id,
                        d.name AS deck_name,
                        s.winner_user_id,
                        s.host_user_id,
                        u.username AS host_username,
                        u.name AS host_name,
                        COALESCE(COUNT(DISTINCT p.user_id), 0) AS participant_count
                 FROM multiplayer_sessions s
                 LEFT JOIN decks d ON d.id = s.deck_id
                 LEFT JOIN users u ON u.id = s.host_user_id
                 LEFT JOIN multiplayer_session_participants p ON p.session_id = s.id
                 WHERE s.status IN ('waiting', 'active')
                 GROUP BY s.id, d.name, u.username, u.name
                 ORDER BY s.created_at DESC
                 LIMIT 12`
            );

            res.json({
                me: stats.rows[0] || {
                    wins: 0,
                    correct_answers: 0,
                    total_answers: 0,
                    points: 0,
                    sessions_played: 0,
                    total_time_ms: 0,
                    accuracy: 0,
                    position: null
                },
                leaderboard: leaderboard.rows,
                history: history.rows,
                activeSessions: recentSessions.rows
            });
        } catch (error) {
            console.error('multiplayer overview error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.get('/api/multiplayer/invites', authenticateToken, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT i.id,
                        i.session_id,
                        i.inviter_user_id,
                        i.invitee_user_id,
                        i.invitee_username,
                        i.status,
                        i.created_at,
                        s.code,
                        s.mode,
                        s.input_mode,
                        s.status AS session_status,
                        s.deck_id,
                        d.name AS deck_name,
                        u.username AS inviter_username,
                        u.name AS inviter_name
                 FROM multiplayer_session_invites i
                 JOIN multiplayer_sessions s ON s.id = i.session_id
                 JOIN users u ON u.id = i.inviter_user_id
                 LEFT JOIN decks d ON d.id = s.deck_id
                 WHERE i.invitee_user_id = $1 AND i.status = 'pending'
                 ORDER BY i.created_at DESC`,
                [req.user.id]
            );

            res.json({ invites: result.rows });
        } catch (error) {
            console.error('multiplayer invites error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.post('/api/multiplayer/sessions', authenticateToken, async (req, res) => {
        const client = await pool.connect();
        try {
            const { deckId, mode = 'competitive', inputMode = 'buttons' } = req.body;
            if (!deckId) {
                return res.status(400).json({ error: 'Не выбрана колода' });
            }

            const deckAccess = await client.query(
                `SELECT d.id, d.name
                 FROM user_decks ud
                 JOIN decks d ON d.id = ud.deck_id
                 WHERE ud.user_id = $1 AND d.id = $2`,
                [req.user.id, deckId]
            );

            if (deckAccess.rows.length === 0) {
                return res.status(403).json({ error: 'Колода недоступна' });
            }

            const cardsResult = await client.query(
                `SELECT id, front, back
                 FROM cards
                 WHERE deck_id = $1
                 ORDER BY id ASC`,
                [deckId]
            );

            if (cardsResult.rows.length === 0) {
                return res.status(400).json({ error: 'В колоде нет карточек' });
            }

            let code = generateSessionCode();
            let existing = await client.query('SELECT id FROM multiplayer_sessions WHERE code = $1', [code]);
            while (existing.rows.length > 0) {
                code = generateSessionCode();
                existing = await client.query('SELECT id FROM multiplayer_sessions WHERE code = $1', [code]);
            }

            await client.query('BEGIN');

            const sessionResult = await client.query(
                `INSERT INTO multiplayer_sessions (
                    code, host_user_id, deck_id, mode, input_mode, status, cards_snapshot
                 ) VALUES ($1, $2, $3, $4, $5, 'waiting', $6)
                 RETURNING *`,
                [code, req.user.id, deckId, mode, inputMode, cardsResult.rows]
            );

            const session = sessionResult.rows[0];
            await client.query(
                `INSERT INTO multiplayer_session_participants (session_id, user_id, status)
                 VALUES ($1, $2, 'active')`,
                [session.id, req.user.id]
            );

            await client.query('COMMIT');

            const payload = await buildSessionPayload(pool, session.id, req.user.id);
            res.status(201).json({ session: payload });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('multiplayer create session error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        } finally {
            client.release();
        }
    });

    app.post('/api/multiplayer/sessions/join', authenticateToken, async (req, res) => {
        try {
            const code = (req.body.code || '').toString().trim().toUpperCase();
            if (!code) {
                return res.status(400).json({ error: 'Введите код сессии' });
            }

            const sessionResult = await pool.query('SELECT * FROM multiplayer_sessions WHERE code = $1', [code]);
            if (sessionResult.rows.length === 0) {
                return res.status(404).json({ error: 'Сессия не найдена' });
            }

            const session = sessionResult.rows[0];
            if (session.status === 'finished') {
                return res.status(400).json({ error: 'Сессия уже завершена' });
            }

            const existingParticipant = await pool.query(
                'SELECT * FROM multiplayer_session_participants WHERE session_id = $1 AND user_id = $2',
                [session.id, req.user.id]
            );

            if (existingParticipant.rows.length === 0) {
                if (session.status !== 'waiting') {
                    return res.status(400).json({ error: 'Сессия уже запущена' });
                }

                await pool.query(
                    `INSERT INTO multiplayer_session_participants (session_id, user_id, status)
                     VALUES ($1, $2, 'active')`,
                    [session.id, req.user.id]
                );
            } else {
                await pool.query(
                    `UPDATE multiplayer_session_participants
                     SET status = 'active', last_seen_at = CURRENT_TIMESTAMP
                     WHERE session_id = $1 AND user_id = $2`,
                    [session.id, req.user.id]
                );
            }

            const payload = await buildSessionPayload(pool, session.id, req.user.id);
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

            const session = await loadSessionById(pool, sessionId);
            if (!session) {
                return res.status(404).json({ error: 'Сессия не найдена' });
            }

            if (Number(session.host_user_id) !== Number(req.user.id)) {
                return res.status(403).json({ error: 'Доступ запрещён' });
            }

            await pool.query('DELETE FROM multiplayer_sessions WHERE id = $1', [sessionId]);

            io.to(createRoomName(sessionId)).emit('multiplayer:sessionDeleted', {
                sessionId,
                code: session.code
            });

            res.json({ deleted: true, sessionId });
        } catch (error) {
            console.error('multiplayer delete session error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.post('/api/multiplayer/sessions/:id/invites', authenticateToken, async (req, res) => {
        try {
            const sessionId = Number(req.params.id);
            const username = (req.body.username || '').toString().trim();
            if (!sessionId || !username) {
                return res.status(400).json({ error: 'Укажите логин пользователя' });
            }

            const access = await findAccessibleSession(sessionId, req.user.id);
            if (!access || Number(access.session.host_user_id) !== Number(req.user.id)) {
                return res.status(403).json({ error: 'Доступ запрещён' });
            }

            if (access.session.status !== 'waiting') {
                return res.status(400).json({ error: 'Приглашения доступны только до старта сессии' });
            }

            const userResult = await pool.query('SELECT id, username, name, avatar FROM users WHERE username = $1', [username]);
            if (userResult.rows.length === 0) {
                return res.status(404).json({ error: 'Пользователь не найден' });
            }

            const targetUser = userResult.rows[0];
            if (Number(targetUser.id) === Number(req.user.id)) {
                return res.status(400).json({ error: 'Нельзя пригласить самого себя' });
            }

            const participantCheck = await pool.query(
                'SELECT id FROM multiplayer_session_participants WHERE session_id = $1 AND user_id = $2',
                [sessionId, targetUser.id]
            );

            if (participantCheck.rows.length > 0) {
                return res.status(400).json({ error: 'Пользователь уже участвует в сессии' });
            }

            const inviteResult = await pool.query(
                `INSERT INTO multiplayer_session_invites (
                    session_id, inviter_user_id, invitee_user_id, invitee_username, status
                 ) VALUES ($1, $2, $3, $4, 'pending')
                 RETURNING *`,
                [sessionId, req.user.id, targetUser.id, targetUser.username]
            );

            const invite = inviteResult.rows[0];
            const inviter = await pool.query('SELECT username, name FROM users WHERE id = $1', [req.user.id]);
            const payload = {
                id: invite.id,
                sessionId,
                sessionCode: access.session.code,
                deckName: access.session.deck_name,
                mode: access.session.mode,
                inputMode: access.session.input_mode,
                inviterUsername: inviter.rows[0]?.username || '',
                inviterName: inviter.rows[0]?.name || ''
            };

            const targetSocketId = connectedUsers.get(Number(targetUser.id));
            if (targetSocketId) {
                io.to(targetSocketId).emit('multiplayer:invite', payload);
            }

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
            if (!inviteId || !['accept', 'decline'].includes(action)) {
                return res.status(400).json({ error: 'Неверное действие' });
            }

            const inviteResult = await pool.query('SELECT * FROM multiplayer_session_invites WHERE id = $1', [inviteId]);
            if (inviteResult.rows.length === 0) {
                return res.status(404).json({ error: 'Приглашение не найдено' });
            }

            const invite = inviteResult.rows[0];
            if (Number(invite.invitee_user_id) !== Number(req.user.id)) {
                return res.status(403).json({ error: 'Доступ запрещён' });
            }

            const session = await loadSessionById(pool, invite.session_id);
            if (!session || session.status === 'finished') {
                return res.status(400).json({ error: 'Сессия недоступна' });
            }

            await pool.query(
                `UPDATE multiplayer_session_invites
                 SET status = $1, responded_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [action === 'accept' ? 'accepted' : 'declined', inviteId]
            );

            if (action === 'accept') {
                const participantCheck = await pool.query(
                    'SELECT id FROM multiplayer_session_participants WHERE session_id = $1 AND user_id = $2',
                    [session.id, req.user.id]
                );

                if (participantCheck.rows.length === 0) {
                    await pool.query(
                        `INSERT INTO multiplayer_session_participants (session_id, user_id, status)
                         VALUES ($1, $2, 'active')`,
                        [session.id, req.user.id]
                    );
                } else {
                    await pool.query(
                        `UPDATE multiplayer_session_participants
                         SET status = 'active', last_seen_at = CURRENT_TIMESTAMP
                         WHERE session_id = $1 AND user_id = $2`,
                        [session.id, req.user.id]
                    );
                }
            }

            const payload = await buildSessionPayload(pool, session.id, req.user.id);
            res.json({ inviteId, action, session: payload });
        } catch (error) {
            console.error('multiplayer invite respond error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.post('/api/multiplayer/sessions/:id/start', authenticateToken, async (req, res) => {
        try {
            const sessionId = Number(req.params.id);
            const session = await loadSessionById(pool, sessionId);
            if (!session) {
                return res.status(404).json({ error: 'Сессия не найдена' });
            }

            if (Number(session.host_user_id) !== Number(req.user.id)) {
                return res.status(403).json({ error: 'Доступ запрещён' });
            }

            if (session.status !== 'waiting') {
                return res.status(400).json({ error: 'Сессия уже запущена' });
            }

            const participants = await loadParticipants(pool, sessionId);
            const activeParticipants = participants.filter((participant) => participant.status === 'active');
            if (activeParticipants.length < 2) {
                return res.status(400).json({ error: 'Нужно минимум два участника' });
            }

            await pool.query(
                `UPDATE multiplayer_sessions
                 SET status = 'active', started_at = CURRENT_TIMESTAMP, current_card_index = 0, current_card_started_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [sessionId]
            );

            const payload = await emitSessionSnapshot(pool, io, sessionId);
            io.to(createRoomName(sessionId)).emit('multiplayer:roundStarted', {
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
            const sessionId = Number(req.params.id);
            const payload = await buildSessionPayload(pool, sessionId, req.user.id);
            if (!payload) {
                return res.status(404).json({ error: 'Сессия не найдена' });
            }
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

            const session = await loadSessionById(pool, sessionId);
            if (!session) {
                return res.status(404).json({ error: 'Сессия не найдена' });
            }

            if (session.status !== 'active') {
                return res.status(400).json({ error: 'Сессия не активна' });
            }

            const participantResult = await pool.query(
                `SELECT * FROM multiplayer_session_participants
                 WHERE session_id = $1 AND user_id = $2`,
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

            const existingAnswer = await pool.query(
                `SELECT id FROM multiplayer_session_answers
                 WHERE session_id = $1 AND participant_id = $2 AND card_index = $3`,
                [sessionId, participant.id, session.current_card_index]
            );

            if (existingAnswer.rows.length > 0) {
                return res.status(400).json({ error: 'Ответ уже отправлен' });
            }

            const responseMs = session.current_card_started_at
                ? Math.max(0, Date.now() - new Date(session.current_card_started_at).getTime())
                : 0;

            const isCorrect = session.input_mode === 'text'
                ? normalizeText(answerText) === normalizeText(currentCard.back)
                : normalizeText(answerText) === 'know';

            const scoreDelta = session.mode === 'competitive'
                ? (isCorrect ? Math.max(25, 1000 - Math.floor(responseMs / 12)) : 0)
                : (isCorrect ? 1 : 0);

            await pool.query('BEGIN');

            await pool.query(
                `INSERT INTO multiplayer_session_answers (
                    session_id, participant_id, card_index, answer_text, is_correct, response_ms
                 ) VALUES ($1, $2, $3, $4, $5, $6)`,
                [sessionId, participant.id, session.current_card_index, answerText, isCorrect, responseMs]
            );

            await pool.query(
                `UPDATE multiplayer_session_participants
                 SET correct_count = correct_count + $1,
                     incorrect_count = incorrect_count + $2,
                     total_time_ms = total_time_ms + $3,
                     score = score + $4,
                     last_seen_at = CURRENT_TIMESTAMP
                 WHERE id = $5`,
                [isCorrect ? 1 : 0, isCorrect ? 0 : 1, responseMs, scoreDelta, participant.id]
            );

            await pool.query('COMMIT');

            const updatedSession = await loadSessionById(pool, sessionId);
            const participants = await loadParticipants(pool, sessionId);
            const answers = await loadAnswers(pool, sessionId);
            const currentAnswers = answers.filter((answer) => Number(answer.card_index) === Number(updatedSession.current_card_index));
            const activeParticipants = participants.filter((item) => item.status === 'active');
            const roundResult = {
                session: await buildSessionPayload(pool, sessionId, req.user.id),
                currentAnswer: {
                    userId: req.user.id,
                    username: participants.find((item) => Number(item.user_id) === Number(req.user.id))?.username || req.user.username,
                    isCorrect,
                    responseMs,
                    scoreDelta
                },
                roundResults: currentAnswers.map((answer) => ({
                    userId: answer.user_id,
                    username: answer.username,
                    isCorrect: answer.is_correct,
                    responseMs: answer.response_ms
                })),
                allAnswered: currentAnswers.length >= activeParticipants.length
            };

            io.to(createRoomName(sessionId)).emit('multiplayer:roundResult', roundResult);

            if (currentAnswers.length >= activeParticipants.length) {
                await advanceSessionIfNeeded(pool, io, sessionId);
            } else {
                await emitSessionSnapshot(pool, io, sessionId);
            }

            res.json({
                ok: true,
                isCorrect,
                responseMs,
                scoreDelta,
                session: await buildSessionPayload(pool, sessionId, req.user.id),
                allAnswered: currentAnswers.length >= activeParticipants.length
            });
        } catch (error) {
            await pool.query('ROLLBACK').catch(() => {});
            console.error('multiplayer answer error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.get('/api/multiplayer/leaderboard', authenticateToken, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT ranked.position,
                        ranked.user_id,
                        ranked.username,
                        ranked.name,
                        ranked.avatar,
                        ranked.wins,
                        ranked.correct_answers,
                        ranked.total_answers,
                        ranked.points,
                        ranked.sessions_played,
                        ranked.total_time_ms,
                        ranked.accuracy
                 FROM (
                    SELECT u.id AS user_id,
                           u.username,
                           u.name,
                           u.avatar,
                           COALESCE(us.wins, 0) AS wins,
                           COALESCE(us.correct_answers, 0) AS correct_answers,
                           COALESCE(us.total_answers, 0) AS total_answers,
                           COALESCE(us.points, 0) AS points,
                           COALESCE(us.sessions_played, 0) AS sessions_played,
                           COALESCE(us.total_time_ms, 0) AS total_time_ms,
                           COALESCE(ROUND((us.correct_answers::numeric / NULLIF(us.total_answers, 0)) * 100, 1), 0) AS accuracy,
                           ROW_NUMBER() OVER (ORDER BY COALESCE(us.points, 0) DESC, COALESCE(us.wins, 0) DESC, COALESCE(us.correct_answers, 0) DESC, COALESCE(us.total_time_ms, 0) ASC) AS position
                    FROM users u
                    LEFT JOIN multiplayer_user_stats us ON us.user_id = u.id
                 ) ranked
                 ORDER BY ranked.position
                 LIMIT 50`
            );
            res.json({ leaderboard: result.rows });
        } catch (error) {
            console.error('multiplayer leaderboard error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.get('/api/multiplayer/history', authenticateToken, async (req, res) => {
        try {
            const result = await pool.query(
                `SELECT s.id,
                        s.code,
                        s.mode,
                        s.input_mode,
                        s.status,
                        s.created_at,
                        s.started_at,
                        s.finished_at,
                        s.deck_id,
                        d.name AS deck_name,
                        s.winner_user_id,
                        COALESCE(json_agg(json_build_object(
                            'id', p.id,
                            'userId', p.user_id,
                            'username', u.username,
                            'name', u.name,
                            'correctCount', p.correct_count,
                            'incorrectCount', p.incorrect_count,
                            'totalTimeMs', p.total_time_ms,
                            'score', p.score,
                            'status', p.status
                        ) ORDER BY p.joined_at ASC) FILTER (WHERE p.id IS NOT NULL), '[]') AS participants
                 FROM multiplayer_sessions s
                 JOIN multiplayer_session_participants p ON p.session_id = s.id
                 JOIN users u ON u.id = p.user_id
                 LEFT JOIN decks d ON d.id = s.deck_id
                 WHERE p.user_id = $1
                 GROUP BY s.id, d.name
                 ORDER BY s.created_at DESC`,
                [req.user.id]
            );

            res.json({ history: result.rows });
        } catch (error) {
            console.error('multiplayer history error:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    io.on('connection', (socket) => {
        socket.on('multiplayer:joinRoom', async ({ sessionId }) => {
            try {
                const numericSessionId = Number(sessionId);
                const userId = socket.data?.userId;
                if (!numericSessionId || !userId) return;

                const access = await findAccessibleSession(numericSessionId, userId);
                if (!access) return;

                socket.join(createRoomName(numericSessionId));
                const payload = await buildSessionPayload(pool, numericSessionId, userId);
                socket.emit('multiplayer:sessionState', payload);
            } catch (error) {
                console.error('multiplayer joinRoom error:', error);
            }
        });

        socket.on('multiplayer:leaveRoom', ({ sessionId }) => {
            const numericSessionId = Number(sessionId);
            if (!numericSessionId) return;
            socket.leave(createRoomName(numericSessionId));
        });
    });

    return {
        emitSessionSnapshot: (sessionId) => emitSessionSnapshot(pool, io, sessionId),
        buildSessionPayload: (sessionId, viewerUserId) => buildSessionPayload(pool, sessionId, viewerUserId)
    };
}

module.exports = {
    registerMultiplayer,
    ensureMultiplayerSchema,
    buildSessionPayload,
    emitSessionSnapshot,
    advanceSessionIfNeeded,
    finalizeSession
};