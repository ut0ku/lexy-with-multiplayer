import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSwipeable } from 'react-swipeable';
import { io } from 'socket.io-client';
import { api } from '../api';

const CURRENT_SESSION_KEY = 'lexy_multiplayer_session_id';
const MULTIPLAYER_SOCKET_URL = import.meta.env.VITE_MULTIPLAYER_SOCKET_URL || 'http://localhost:3003';

function formatDuration(ms) {
  if (!ms && ms !== 0) return '0с';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes === 0) return `${remainder}с`;
  return `${minutes}м ${remainder}с`;
}

function getStoredUser() {
  try {
    const value = localStorage.getItem('lexy_user');
    if (!value || value === 'undefined') return null;
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

export default function Multiplayer({ onShowNotification }) {
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState({ leaderboard: [], me: {} });
  const [availableDecks, setAvailableDecks] = useState([]);
  const [pendingInvites, setPendingInvites] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [selectedDeckId, setSelectedDeckId] = useState('');
  const [joinCode, setJoinCode] = useState('');

  const [answerValue, setAnswerValue] = useState('');
  const [roundNotice, setRoundNotice] = useState(null);
  const [showFinishedModal, setShowFinishedModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  
  const socketRef = useRef(null);
  const previousSessionStatusRef = useRef(null);

  const currentUser = useMemo(() => getStoredUser(), []);

  const notify = useCallback((message, type = 'success') => {
    if (onShowNotification) {
      onShowNotification(message, type);
    }
  }, [onShowNotification]);

  const attachSocketListeners = useCallback((sessionId) => {
    const socket = socketRef.current;
    if (!socket) return;

    socket.emit('multiplayer:joinRoom', { sessionId });
  }, []);

  const loadOverview = useCallback(async () => {
    try {
      const data = await api.multiplayer.getOverview();
      setOverview({
        leaderboard: data.leaderboard || [],
        me: data.me || {}
      });
    } catch (error) {
      notify(error.message || 'Не удалось загрузить мультиплеер', 'error');
    }
  }, [notify]);

  const loadDecks = useCallback(async () => {
    try {
      const data = await api.getMyDecks();
      const decks = Array.isArray(data?.decks) ? data.decks : [];
      setAvailableDecks(decks);
      if (!selectedDeckId && decks.length > 0) {
        setSelectedDeckId(String(decks[0].id));
      }
    } catch (error) {
      notify(error.message || 'Не удалось загрузить колоды', 'error');
    }
  }, [notify, selectedDeckId]);

  const loadStoredSession = useCallback(async () => {
    const storedSessionId = localStorage.getItem(CURRENT_SESSION_KEY);
    if (!storedSessionId) return;

    try {
      const data = await api.multiplayer.getSession(storedSessionId);
      setActiveSession(data.session);
      attachSocketListeners(storedSessionId);
    } catch (error) {
      localStorage.removeItem(CURRENT_SESSION_KEY);
    }
  }, [attachSocketListeners]);

  const syncSessionState = useCallback(async (sessionId) => {
    if (!sessionId) return;

    try {
      const data = await api.multiplayer.getSession(sessionId);
if (data?.session) {
        setActiveSession(data.session);
      }
    } catch (error) {
      // ignore
    }
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('lexy_token');
    if (!token) return undefined;


    let socket = window.multiplayerSocket;
    if (!socket) {

      socket = io(MULTIPLAYER_SOCKET_URL, {
        transports: ['websocket'],
        auth: { token }
      });
    }

    socketRef.current = socket;

    const handleInvite = (invite) => {
      setPendingInvites((prev) => [invite, ...prev.filter((item) => item.id !== invite.id)]);
      notify(`Приглашение в сессию ${invite.sessionCode} от ${invite.inviterUsername}`, 'accent');
    };

    const handleSessionUpdated = (payload) => {
      if (!payload?.session) return;
      if (String(payload.session.id) === String(localStorage.getItem(CURRENT_SESSION_KEY))) {
        syncSessionState(payload.session.id);
      }
      setRoundNotice(payload);
    };

const handleRoundResult = (payload) => {
      if (payload?.session) {
        if (String(payload.session.id) === String(localStorage.getItem(CURRENT_SESSION_KEY))) {
          syncSessionState(payload.session.id);
        }
      }
      setRoundNotice(payload);
    };

    const handleRoundStarted = (payload) => {
      if (payload?.sessionId) {
        const stored = localStorage.getItem(CURRENT_SESSION_KEY);
        if (String(payload.sessionId) === String(stored)) {
          syncSessionState(payload.sessionId);
        }
      }
      setRoundNotice(null);
    };

    const handleSessionState = (payload) => {
      if (payload?.session) {
        syncSessionState(payload.session.id);
      }
    };

    const handleFinished = (payload) => {
      if (payload?.session) {
        syncSessionState(payload.session.id);
      }
      setShowFinishedModal(true);
      setRoundNotice(payload);
      loadOverview();
    };

    const handleOverviewUpdated = () => {};

    socket.on('multiplayer:invite', handleInvite);
    socket.on('multiplayer:sessionUpdated', () => {});
    socket.on('multiplayer:sessionState', () => {});
    socket.on('multiplayer:sessionFinished', handleFinished);
    socket.on('multiplayer:overviewUpdated', handleOverviewUpdated);
    socket.on('multiplayer:roundResult', () => {});
    socket.on('multiplayer:roundStarted', () => {});

    return () => {
      socket.off('multiplayer:invite', handleInvite);
      socket.off('multiplayer:sessionUpdated', () => {});
      socket.off('multiplayer:sessionState', () => {});
      socket.off('multiplayer:sessionFinished', handleFinished);
      socket.off('multiplayer:overviewUpdated', handleOverviewUpdated);
      socket.off('multiplayer:roundResult', () => {});
      socket.off('multiplayer:roundStarted', () => {});

      if (socket !== window.multiplayerSocket) {
        socket.disconnect();
      }
      socketRef.current = null;
    };
  }, [loadOverview, notify]);

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      if (!mounted) return;
      setLoading(true);
      await Promise.all([loadOverview(), loadDecks(), loadStoredSession()]);
      if (mounted) setLoading(false);
    };

    init();

    window.initMultiplayerPage = () => {
      loadOverview();
      loadDecks();
      loadStoredSession();
    };

    document.body.classList.add('dark-theme');
    document.body.classList.remove('light-theme');

    const enforceDarkTheme = () => {
      document.body.classList.add('dark-theme');
      document.body.classList.remove('light-theme');
      const themeToggle = document.getElementById('themeToggle');
      if (themeToggle) {
        themeToggle.checked = false;
      }
    };

    enforceDarkTheme();

    return () => {
      mounted = false;
    };
  }, [loadDecks, loadOverview, loadStoredSession]);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (document.body.classList.contains('light-theme')) {
        document.body.classList.remove('light-theme');
        document.body.classList.add('dark-theme');
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const handleCreateSession = async (event) => {
    event.preventDefault();
    if (!selectedDeckId) {
      notify('Выберите колоду', 'error');
      return;
    }

    try {
      setSubmitting(true);
      const result = await api.multiplayer.createSession(selectedDeckId, 'competitive', 'buttons');
      const sessionPayload = result.session;
      if (sessionPayload?.session?.id) {
        setActiveSession(sessionPayload);
        localStorage.setItem(CURRENT_SESSION_KEY, String(sessionPayload.session.id));
        attachSocketListeners(sessionPayload.session.id);
      }
      await loadOverview();
      notify('Комната мультиплеера создана');
    } catch (error) {
      notify(error.message || 'Не удалось создать комнату', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleJoinByCode = async (event) => {
    event.preventDefault();
    if (!joinCode.trim()) {
      notify('Введите код сессии', 'error');
      return false;
    }

    try {
      setSubmitting(true);
      const result = await api.multiplayer.joinByCode(joinCode.trim());
      const sessionPayload = result.session;
      if (sessionPayload?.session?.id) {
        setActiveSession(sessionPayload);
        localStorage.setItem(CURRENT_SESSION_KEY, String(sessionPayload.session.id));
        attachSocketListeners(sessionPayload.session.id);
      }
      setJoinCode('');
      await loadOverview();
      notify('Вы подключились к сессии');
      return true;
    } catch (error) {
      notify(error.message || 'Не удалось подключиться', 'error');
      return false;
    } finally {
      setSubmitting(false);
    }
};

  const handleLeaveLobby = async (sessionId) => {
    if (!sessionId) return;

    try {
      setSubmitting(true);
      const isCreator = String(activeSession?.session?.hostUserId) === String(currentUser?.id);
      if (isCreator) {
        const socket = socketRef.current;
        if (socket) {
          socket.emit('multiplayer:leaveRoom', { sessionId });
        }
        setActiveSession(null);
        setRoundNotice(null);
        setShowFinishedModal(true);
        localStorage.removeItem(CURRENT_SESSION_KEY);
        await loadOverview();
        notify('Вы покинули лобби');
      } else {
        await api.multiplayer.leaveSession(sessionId);
        const socket = socketRef.current;
        if (socket) {
          socket.emit('multiplayer:leaveRoom', { sessionId });
        }
        setActiveSession(null);
        setRoundNotice(null);
        setShowFinishedModal(true);
        localStorage.removeItem(CURRENT_SESSION_KEY);
        await loadOverview();
        notify('Вы покинули лобби');
      }
    } catch (error) {
      notify(error.message || 'Не удалось покинуть лобби', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleInviteAction = async (inviteId, action) => {
    try {
      const result = await api.multiplayer.respondToInvite(inviteId, action);
      if (action === 'accept' && result.session?.session?.id) {
        setActiveSession(result.session);
        localStorage.setItem(CURRENT_SESSION_KEY, String(result.session.session.id));
        attachSocketListeners(result.session.session.id);
        notify('Приглашение принято');
      } else {
        notify('Приглашение отклонено');
      }
    } catch (error) {
      notify(error.message || 'Не удалось обработать приглашение', 'error');
    }
  };

  const handleStartSession = async () => {
    if (!activeSession?.session?.id) return;
    try {
      setSubmitting(true);
      const result = await api.multiplayer.startSession(activeSession.session.id);
      const sessionPayload = result.session;
      if (sessionPayload?.session?.id) {
        setActiveSession(sessionPayload);
        localStorage.setItem(CURRENT_SESSION_KEY, String(sessionPayload.session.id));
        attachSocketListeners(sessionPayload.session.id);
      }
      await loadOverview();
      notify('Сессия запущена');
    } catch (error) {
      notify(error.message || 'Не удалось запустить сессию', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitAnswer = async (value) => {
    if (!activeSession?.session?.id) return;

    try {
      setSubmitting(true);
      const result = await api.multiplayer.submitAnswer(activeSession.session.id, value);
      if (result.session?.session?.id) {
        setActiveSession(result.session);
      }
      setRoundNotice(result);
      setAnswerValue('');
      if (result.allAnswered) {
        await loadOverview();
      }
      return result;
    } catch (error) {
      notify(error.message || 'Не удалось отправить ответ', 'error');
      return null;
    } finally {
      setSubmitting(false);
    }
  };

  const handleJoinSessionCard = async (sessionId) => {
    try {
      const data = await api.multiplayer.getSession(sessionId);
      setActiveSession(data.session);
      localStorage.setItem(CURRENT_SESSION_KEY, String(data.session.id));
      attachSocketListeners(data.session.id);
      notify('Сессия открыта');
    } catch (error) {
      notify(error.message || 'Не удалось открыть сессию', 'error');
    }
  };


  const StudySession = ({ currentCard, cardIndex, totalCards, inputMode, onSubmitAnswer, submitting }) => {
    const [userAnswer, setUserAnswer] = useState('');
    const [isSwiping, setIsSwiping] = useState(false);
    const [swipeOffset, setSwipeOffset] = useState(0);
    const [rotation, setRotation] = useState(0);
    const [isLeaving, setIsLeaving] = useState(false);
    const [studyNotification, setStudyNotification] = useState(null);
    const autoSwipedRef = useRef(false);

    const isWritten = inputMode === 'text';
    const displayText = currentCard?.front || currentCard?.word || '';
    const correctAnswer = currentCard?.back || currentCard?.translation || '';

    const notifyLocal = (text, type) => {
      setStudyNotification({ text, type });
      setTimeout(() => setStudyNotification(null), 1800);
    };

    const animateAndNext = async (direction, payloadValue) => {
      if (isLeaving) return;
      setIsLeaving(true);
      setIsSwiping(false);

      const offsetDistance = 250;
      setSwipeOffset(direction === 'right' ? offsetDistance : -offsetDistance);
      setRotation(direction === 'right' ? 12 : -12);

      try {
        const result = await onSubmitAnswer(payloadValue);
        if (result && result.isCorrect) notifyLocal('Правильно!', 'success');else
        notifyLocal(`Неверно. Правильно: ${correctAnswer}`, 'error');
      } catch (e) {
        notifyLocal('Ошибка отправки', 'error');
      }

      setTimeout(() => {
        setIsLeaving(false);
        setSwipeOffset(0);
        setRotation(0);
        autoSwipedRef.current = false;
        setUserAnswer('');
      }, 500);
    };

    const handleKnow = () => animateAndNext('right', 'know');
    const handleDontKnow = () => animateAndNext('left', 'dont_know');

    const swipeHandlers = useSwipeable({
      onSwipedLeft: () => {if (!autoSwipedRef.current && !isLeaving && !isWritten) handleDontKnow();},
      onSwipedRight: () => {if (!autoSwipedRef.current && !isLeaving && !isWritten) handleKnow();},
      onSwiping: ({ deltaX }) => {
        if (!isWritten && !autoSwipedRef.current && !isLeaving) {
          if (deltaX > 150) {autoSwipedRef.current = true;handleKnow();} else
          if (deltaX < -150) {autoSwipedRef.current = true;handleDontKnow();} else
          {setSwipeOffset(deltaX);setRotation(deltaX * 0.1);setIsSwiping(true);}
        }
      },
      onSwiped: () => {if (!isLeaving) {autoSwipedRef.current = false;setIsSwiping(false);setSwipeOffset(0);setRotation(0);}},
      preventDefaultTouchmoveEvent: true,
      trackMouse: true,
      trackTouch: !isWritten
    });

    const handleCheckAnswer = async () => {
      try {
        const result = await onSubmitAnswer(userAnswer);
        if (result && result.isCorrect) notifyLocal('Правильно!', 'success');else
        notifyLocal(`Неверно. Правильный ответ: ${correctAnswer}`, 'error');
      } catch (e) {
        notifyLocal('Ошибка отправки', 'error');
      }
      setUserAnswer('');
    };

    return (
      <div className="auth-modal active">
        <div className="auth-container study-modal" style={{ maxWidth: '600px' }}>
          <h3>Карточка {cardIndex + 1} / {totalCards}</h3>
          
          <div
            className="study-card"
            id="studyCard"
            style={{
              fontSize: '24px',
              textAlign: 'center',
              padding: '40px',
              margin: '20px 0',
              background: swipeOffset > 50 ? 'rgba(52, 199, 89, 0.1)' : swipeOffset < -50 ? 'rgba(255, 59, 48, 0.1)' : 'var(--bg-secondary)',
              borderRadius: '12px',
              opacity: isLeaving ? 0 : 1,
              transform: `translate(${swipeOffset}px, ${-Math.abs(swipeOffset) * 0.25}px) rotate(${rotation}deg)`,
              transition: isSwiping ? 'transform 0.1s ease-out' : 'transform 0.5s cubic-bezier(0.25, 0.8, 0.25, 1), opacity 0.5s ease',
              userSelect: 'none',
              border: swipeOffset > 50 ? '2px solid #34c759' : swipeOffset < -50 ? '2px solid #ff3b30' : '1px solid var(--border)',
              transformOrigin: 'center',
              touchAction: 'none'
            }}
            {...swipeHandlers}>
            
            {displayText}
          </div>

          {isWritten ?
          <div style={{ marginTop: '20px' }}>
              <input
              type="text"
              placeholder="Введите перевод..."
              value={userAnswer}
              onChange={(e) => setUserAnswer(e.target.value)}
              style={{ width: '100%', padding: '10px' }}
              onKeyPress={(e) => e.key === 'Enter' && handleCheckAnswer()} />
            
              <button
              className="btn-primary"
              onClick={handleCheckAnswer}
              disabled={submitting || !userAnswer.trim()}
              style={{ marginTop: '10px', width: '100%' }}>
              
                Проверить
              </button>
            </div> :

          <div className="study-controls" style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
              <button className="control-btn left" onClick={handleDontKnow} disabled={isLeaving || submitting}>← Не знаю</button>
              <button className="control-btn right" onClick={handleKnow} disabled={isLeaving || submitting}>Знаю →</button>
            </div>
          }

          <p style={{ textAlign: 'center', marginTop: '16px', fontSize: '13px', color: 'var(--text-secondary)' }}>
            {correctAnswer ? 'Ответ сравнивается в реальном времени с сервером' : ''}
          </p>
        </div>

        {studyNotification &&
        <div style={{
          position: 'fixed',
          bottom: '40px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: studyNotification.type === 'success' ? '#34c759' : '#ff3b30',
          color: 'white',
          padding: '12px 24px',
          borderRadius: '24px',
          fontSize: '16px',
          fontWeight: 'bold',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          zIndex: 9999,
          maxWidth: '90%',
          textAlign: 'center',
          width: 'fit-content',
          animation: 'slideUpFadeIn 0.3s ease forwards'
        }}>
            {studyNotification.text}
          </div>
        }
      </div>);

};

  const session = activeSession?.session || null;
  const participants = activeSession?.participants || [];
  const currentCard = activeSession?.currentCard || null;
  const isHost = String(session?.hostUserId) === String(currentUser?.id);
  const canStart = isHost && session?.status === 'waiting';

  return (
    <div className="multiplayer-page">
      <section className="multiplayer-hero">
        <div>
          <div className="multiplayer-badge">Live multiplayer</div>
          <h1>Мультиплеер Lexy</h1>
          <p>
            Создавайте комнаты, приглашайте по логину или коду, проходите карточки синхронно и сравнивайте результат после каждого ответа.
          </p>
        </div>
        <div className="multiplayer-stat-strip">
          <div>
            <span>Побед</span>
            <strong>{overview.me?.wins || 0}</strong>
          </div>
          <div>
            <span>Точность</span>
            <strong>{overview.me?.accuracy || 0}%</strong>
          </div>
          <div>
            <span>Очки</span>
            <strong>{overview.me?.points || 0}</strong>
          </div>
        </div>
      </section>

      <div className="multiplayer-grid">
        <section className="multiplayer-card">
          <h2>Создать комнату</h2>
          <form className="multiplayer-form" onSubmit={handleCreateSession}>
            <label>
              Колода
              <select value={selectedDeckId} onChange={(event) => setSelectedDeckId(event.target.value)}>
                <option value="">Выберите колоду</option>
                {availableDecks.map((deck) =>
                <option key={deck.id} value={deck.id}>
                    {deck.name}
                  </option>
                )}
              </select>
            </label>
            <button className="btn-primary" type="submit" disabled={submitting}>
              Создать сессию
            </button>
          </form>
        </section>

        <section className="multiplayer-card">
          <h2>Подключиться по коду</h2>
          <form className="multiplayer-form" onSubmit={handleJoinByCode}>
            <label>
              Код комнаты
              <input value={joinCode} onChange={(event) => setJoinCode(event.target.value)} placeholder="Например, A1B2C3" />
            </label>
            <button className="btn-outline" type="submit" disabled={submitting}>
              Подключиться
            </button>
          </form>
        </section>

        <section className="multiplayer-card wide">
          <h2>Текущая сессия</h2>
          {activeSession ?
          <div className="session-panel">
              <div className="session-meta">
                <span>Код: {session?.code}</span>
                <span>Режим: {session?.mode === 'competitive' ? 'соревновательный' : 'совместный'}</span>
              </div>

              <div className="session-toolbar">
                <div className="session-toolbar-actions">
                  {canStart &&
                  <button className="btn-primary" type="button" onClick={handleStartSession} disabled={submitting}>
                      Запустить сессию
                    </button>
                  }
                </div>
              </div>

              <div className="session-participants">
                {participants.map((participant) =>
              <div key={participant.userId} className="participant-pill">
                    <strong>{participant.username}</strong>
                    <span>{participant.correctCount} верных</span>
                    <span>{participant.score} очков</span>
                  </div>
              )}
              </div>

              {session?.status === 'active' && currentCard ?
            <StudySession
              currentCard={currentCard}
              cardIndex={session.currentCardIndex}
              totalCards={session.totalCards}
              inputMode={session.inputMode}
              onSubmitAnswer={handleSubmitAnswer}
              submitting={submitting} /> :

            session?.status === 'finished' && showFinishedModal ?
            <div className="auth-modal active">
                  <div className="auth-container result-modal" style={{ maxWidth: '500px', textAlign: 'center' }}>
                    <button type="button" className="auth-close" onClick={() => {
                  if (session?.id) handleLeaveLobby(session.id);
                }} style={{ position: 'absolute', top: '15px', right: '20px' }}>×</button>
                    <h2 style={{ marginBottom: '24px' }}>Игра завершена</h2>
                    
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '24px' }}>
                      {[...participants].sort((a, b) => b.score - a.score).map((participant, index) =>
                  <div key={participant.userId} style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '16px 20px',
                    background: index === 0 ? 'rgba(52, 199, 89, 0.1)' : 'var(--bg-secondary)',
                    border: index === 0 ? '2px solid #34c759' : '1px solid var(--border)',
                    borderRadius: '12px'
                  }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                            <span style={{ fontSize: '24px', fontWeight: 'bold', color: index === 0 ? '#34c759' : 'var(--text-secondary)' }}>
                              #{index + 1}
                            </span>
                            <strong style={{ fontSize: '18px' }}>{participant.username}</strong>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <div style={{ fontWeight: 'bold', fontSize: '18px', color: 'var(--text-primary)' }}>{participant.score} очков</div>
                            <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>{participant.correctCount} верных</div>
                          </div>
                        </div>
                  )}
                    </div>

                    <button type="button" className="btn-primary" style={{ width: '100%' }} onClick={() => {
                  if (session?.id) handleLeaveLobby(session.id);
                }}>
                      Выйти из игры
                    </button>
                  </div>
                </div> :
            session?.status === 'finished' ?
            <div className="waiting-state">
                  <p>Игра завершена. Сессия сохранена, модальное окно закрыто.</p>
                </div> :

            <div className="waiting-state">
                  <p>Ожидание старта или завершения сессии.</p>
                </div>
            }

              {roundNotice?.roundResults?.length ?
            <div className="round-results">
                  <h3>Результаты раунда</h3>
                  <div className="round-results-grid">
                    {roundNotice.roundResults.map((result) =>
                <div key={`${result.userId}-${result.responseMs}`} className={`round-result ${result.isCorrect ? 'success' : 'error'}`}>
                        <strong>{result.username}</strong>
                        <span>{result.isCorrect ? 'Верно' : 'Неверно'}</span>
                        <span>{formatDuration(result.responseMs)}</span>
                      </div>
                )}
                  </div>
                </div> :
            null}
            </div> :

          <div className="empty-state">
              <p>Создайте комнату или подключитесь по коду, чтобы начать.</p>
            </div>
          }
        </section>



        <section className="multiplayer-card">
          <h2>Рейтинг</h2>
        </section>

      </div>


    </div>);

}

