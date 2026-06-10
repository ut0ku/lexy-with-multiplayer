import React, { useState, useEffect } from 'react';
import { api } from '../api';

export default function Auth({ onAuthSuccess, onShowNotification }) {
  const [activeTab, setActiveTab] = useState('login');
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [regName, setRegName] = useState('');
  const [regUsername, setRegUsername] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [isVisible, setIsVisible] = useState(true);
  const [isLoading, setIsLoading] = useState(false);

  const showNotification = (message, type = 'success') => {
    if (onShowNotification) {
      onShowNotification(message, type);
    } else {
      alert(message);
    }
  };

  const openAuthModal = () => {
    const token = localStorage.getItem('lexy_token');
    const userStr = localStorage.getItem('lexy_user');
    let user = null;
    try {
      if (userStr && userStr !== 'undefined') user = JSON.parse(userStr);
    } catch (e) {
      localStorage.removeItem('lexy_user');
    }

    // Already logged in - just update UI
    if (token && user && user.username) {
      if (onAuthSuccess) {
        onAuthSuccess('profile');
      }
      return;
    }

    setIsVisible(true);
  };

  const closeAuthModal = () => {
    setIsVisible(false);
    // Clear form fields
    setLoginUsername('');
    setLoginPassword('');
    setRegName('');
    setRegUsername('');
    setRegPassword('');
    setActiveTab('login');
    if (onAuthSuccess) {
      onAuthSuccess('close');
    }
  };

  const switchAuthTab = (tab) => {
    setActiveTab(tab);
  };

  const applyTheme = (theme) => {
    if (theme === 'light') {
      document.body.classList.add('light-theme');
      document.body.classList.remove('dark-theme');
    } else {
      document.body.classList.add('dark-theme');
      document.body.classList.remove('light-theme');
    }
  };

  const saveState = () => {
    if (window.saveState) {
      window.saveState();
    } else if (window.AppState) {
      localStorage.setItem('linguaState', JSON.stringify(window.AppState));
    }
  };

  const updateAuthButton = () => {

    if (onAuthSuccess) {
      onAuthSuccess('update');
    }
  };

  // Login handler
  const handleLogin = async (event) => {
    event.preventDefault();

    if (!loginUsername || !loginPassword) {
      showNotification('Введите логин и пароль', 'error');
      return;
    }

    if (typeof loginUsername !== 'string' || typeof loginPassword !== 'string') {
      showNotification('Введите логин и пароль', 'error');
      return;
    }

    setIsLoading(true);

    try {
      const result = await api.login(loginUsername, loginPassword);

      localStorage.setItem('lexy_token', result.token);

      const savedTheme = window.AppState?.user?.theme || 'dark';

      const userData = {
        id: result.user.id,
        name: result.user.name,
        username: result.user.username,
        avatar: result.user.avatar,
        role: result.user.role,
        notifications_enabled: result.user.notifications_enabled === undefined ? true : !!result.user.notifications_enabled,
        theme: savedTheme,
        streak: 0,
        lastStudyDate: null,
        learnedWords: 0,
        studyTime: 0,
        accuracy: 0,
        activity: {},
        isRegistered: true
      };

      if (window.AppState) {
        window.AppState.user = userData;
      }

      // Load user activity data
      try {
        const activityData = await api.getActivity();
        if (activityData && activityData.activity && window.AppState) {
          window.AppState.user.activity = activityData.activity;
        }
      } catch (e) {
        console.error('Failed to load activity:', e);
      }

      try {
        const stats = await api.getStats();
        if (window.AppState) {
          window.AppState.user.streak = stats.streak || 0;
          window.AppState.user.learnedWords = stats.learned_words || 0;
          window.AppState.user.studyTime = stats.study_time || 0;
          window.AppState.user.accuracy = stats.accuracy || 0;
          if (stats.last_study_date) {
            const d = new Date(stats.last_study_date);
            window.AppState.user.lastStudyDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          } else {
            window.AppState.user.lastStudyDate = null;
          }
        }
      } catch (e) {
        console.error('Failed to load stats:', e);
      }

      localStorage.setItem('lexy_user', JSON.stringify(userData));
      showNotification('Добро пожаловать, ' + result.user.name + '!');

      const localDecks = window.AppState ? [...window.AppState.userDecks] : [];

      if (window.AppState) {
        window.AppState.userDecks = [];
        saveState();
      }


      try {
        // Synchronize local data with server
        const serverData = await api.syncGet();

        if (serverData && serverData.decks && serverData.decks.length > 0) {
          const serverCards = serverData.cards || [];


          const favoriteCards = serverCards.
          filter((card) => card.is_favorite === true || card.is_favorite === 'true').
          map((card) => ({
            id: card.id,
            word: card.front,
            translation: card.back,
            is_favorite: true,
            repetitions: card.repetitions || 0,
            interval: card.interval || 1,
            ease: card.ease || 2.5,
            nextReview: card.next_review
          }));


          const forgottenCards = serverCards.
          filter((card) => card.is_forgotten === true || card.is_forgotten === 'true').
          map((card) => ({
            id: card.id,
            word: card.front,
            translation: card.back,
            is_forgotten: true,
            repetitions: card.repetitions || 0,
            interval: card.interval || 1,
            ease: card.ease || 2.5,
            nextReview: card.next_review
          }));

          if (window.AppState) {
            window.AppState.favoriteDeck = {
              id: 'favorite',
              name: 'Избранное',
              cards: favoriteCards,
              isFavorite: true
            };

            window.AppState.forgottenDeck = {
              id: 'forgotten',
              name: 'Забытые карты',
              cards: forgottenCards,
              isForgotten: true
            };

            // Convert server decks to AppState format
            window.AppState.userDecks = serverData.decks.map((deck) => {
              const deckCards = serverCards.
              filter((card) => card.deck_id === deck.id).
              map((card) => ({
                id: card.id,
                word: card.front,
                translation: card.back,
                is_favorite: card.is_favorite,
                repetitions: card.repetitions || 0,
                interval: card.interval || 1,
                ease: card.ease || 2.5,
                nextReview: card.next_review
              }));

              return {
                ...deck,
                id: deck.id,
                customImage: deck.custom_image || null,
                source: deck.source || 'created',
                publicDeckId: deck.public_deck_id || null,
                cards: deckCards
              };
            });
          }
        } else if (localDecks && localDecks.length > 0 && window.AppState) {

          await api.syncSave(localDecks);
          const updatedData = await api.syncGet();
          if (updatedData && updatedData.decks) {
            const serverCards = updatedData.cards || [];

            const favoriteCards = serverCards.
            filter((card) => card.is_favorite === true || card.is_favorite === 'true').
            map((card) => ({
              id: card.id,
              word: card.front,
              translation: card.back,
              is_favorite: true,
              repetitions: card.repetitions || 0,
              interval: card.interval || 1,
              ease: card.ease || 2.5,
              nextReview: card.next_review
            }));

            const forgottenCards = serverCards.
            filter((card) => card.is_forgotten === true || card.is_forgotten === 'true').
            map((card) => ({
              id: card.id,
              word: card.front,
              translation: card.back,
              is_forgotten: true,
              repetitions: card.repetitions || 0,
              interval: card.interval || 1,
              ease: card.ease || 2.5,
              nextReview: card.next_review
            }));

            window.AppState.favoriteDeck = {
              id: 'favorite',
              name: 'Избранное',
              cards: favoriteCards,
              isFavorite: true
            };

            window.AppState.forgottenDeck = {
              id: 'forgotten',
              name: 'Забытые карты',
              cards: forgottenCards,
              isForgotten: true
            };

            window.AppState.userDecks = updatedData.decks.map((deck) => {
              const deckCards = serverCards.
              filter((card) => card.deck_id === deck.id).
              map((card) => ({
                id: card.id,
                word: card.front,
                translation: card.back,
                is_favorite: card.is_favorite,
                repetitions: card.repetitions || 0,
                interval: card.interval || 1,
                ease: card.ease || 2.5,
                nextReview: card.next_review
              }));

              return {
                ...deck,
                id: deck.id,
                customImage: deck.custom_image || null,
                source: deck.source || 'created',
                publicDeckId: deck.public_deck_id || null,
                cards: deckCards
              };
            });
          }
        }

        saveState();
      } catch (syncError) {
        console.error('Sync error:', syncError);
      }

      applyTheme(userData.theme);
      closeAuthModal();
      updateAuthButton();
      if (typeof window.subscribeUserToPush === 'function') {
        window.subscribeUserToPush();
      }

      if (onAuthSuccess) {
        onAuthSuccess('login', result.user);
      }
    } catch (error) {
      showNotification(error.message, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegister = async (event) => {
    event.preventDefault();

    // Input validation
    if (!regName || !regUsername || !regPassword) {
      showNotification('Заполните все поля', 'error');
      return;
    }

    if (typeof regName !== 'string' || regName.trim().length === 0 || regName.length > 50) {
      showNotification('Имя должно быть от 1 до 50 символов', 'error');
      return;
    }
    if (typeof regUsername !== 'string' || regUsername.trim().length === 0 || regUsername.length > 50) {
      showNotification('Логин должен быть от 1 до 50 символов', 'error');
      return;
    }
    if (typeof regPassword !== 'string' || regPassword.length < 6) {
      showNotification('Пароль должен быть не менее 6 символов', 'error');
      return;
    }

    setIsLoading(true);

    try {
      const result = await api.register(regName, regUsername, regPassword);

      localStorage.setItem('lexy_token', result.token);
      localStorage.setItem('lexy_user', JSON.stringify(result.user));

      if (window.AppState) {
        window.AppState.user = result.user;
        window.AppState.user.isRegistered = true;
        saveState();
      }


      // Sync local decks to newly created account
      if (window.AppState?.userDecks && window.AppState.userDecks.length > 0) {
        try {
          await api.syncSave(window.AppState.userDecks);
          console.log('Data synced to server');
        } catch (syncError) {
          console.error('Sync error:', syncError);
        }
      }

      applyTheme(result.user.theme || 'dark');
      closeAuthModal();
      updateAuthButton();
      showNotification('Аккаунт создан! Добро пожаловать, ' + result.user.name + '!');

      if (typeof window.subscribeUserToPush === 'function') {
        window.subscribeUserToPush();
      }


      // Refresh UI components after registration
      setTimeout(() => {
        if (typeof window.refreshMyDecks === 'function') {
          window.refreshMyDecks();
        }
        if (typeof window.refreshStats === 'function') {
          window.refreshStats();
        }
        if (typeof window.refreshAdminData === 'function') {
          window.refreshAdminData();
        }
      }, 500);

      if (onAuthSuccess) {
        onAuthSuccess('register', result.user);
      }
    } catch (error) {
      showNotification(error.message, 'error');
    } finally {
      setIsLoading(false);
    }
  };


  // Register global methods for external access
  useEffect(() => {
    window.openAuthModal = openAuthModal;
    window.closeAuthModal = closeAuthModal;
    window.switchAuthTab = switchAuthTab;
    window.handleLogin = handleLogin;
    window.handleRegister = handleRegister;
    window.updateAuthButton = updateAuthButton;

    return () => {
      delete window.openAuthModal;
      delete window.closeAuthModal;
      delete window.switchAuthTab;
      delete window.handleLogin;
      delete window.handleRegister;
      delete window.updateAuthButton;
    };
  }, []);

  if (!isVisible) return null;

  return (
    <>
      <div className="auth-modal active" id="authModal">
        <div className="auth-container">
          <button className="auth-close" onClick={closeAuthModal}>×</button>

          {}
          <div className="auth-tabs">
            <button
              className={`auth-tab ${activeTab === 'login' ? 'active' : ''}`}
              data-auth-tab="login"
              onClick={() => switchAuthTab('login')}>
              
              Вход
            </button>
            <button
              className={`auth-tab ${activeTab === 'register' ? 'active' : ''}`}
              data-auth-tab="register"
              onClick={() => switchAuthTab('register')}>
              
              Регистрация
            </button>
          </div>

          {}
          <form className={`auth-form ${activeTab !== 'login' ? 'hidden' : ''}`} id="loginForm" onSubmit={handleLogin}>
            <div className="form-group">
              <label htmlFor="loginUsername">Username</label>
              <input
                type="text"
                id="loginUsername"
                placeholder="username"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                required />
              
            </div>
            <div className="form-group">
              <label htmlFor="loginPassword">Пароль</label>
              <input
                type="password"
                id="loginPassword"
                placeholder="Пароль"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                required />
              
            </div>
            <button type="submit" className="btn btn-full" disabled={isLoading}>
              {isLoading ? 'Вход...' : 'Войти'}
            </button>
          </form>

          {}
          <form className={`auth-form ${activeTab !== 'register' ? 'hidden' : ''}`} id="registerFormModal" onSubmit={handleRegister}>
            <div className="form-group">
              <label htmlFor="regNameModal">Имя</label>
              <input
                type="text"
                id="regNameModal"
                placeholder="Ваше имя"
                value={regName}
                onChange={(e) => setRegName(e.target.value)}
                required />
              
            </div>
            <div className="form-group">
              <label htmlFor="regUsernameModal">Username</label>
              <input
                type="text"
                id="regUsernameModal"
                placeholder="username"
                value={regUsername}
                onChange={(e) => setRegUsername(e.target.value)}
                required />
              
            </div>
            <div className="form-group">
              <label htmlFor="regPasswordModal">Пароль</label>
              <input
                type="password"
                id="regPasswordModal"
                placeholder="Придумайте пароль"
                value={regPassword}
                onChange={(e) => setRegPassword(e.target.value)}
                required />
              
            </div>
            <button type="submit" className="btn btn-full" disabled={isLoading}>
              {isLoading ? 'Создание...' : 'Создать аккаунт'}
            </button>
          </form>
        </div>
      </div>

      {}
    </>);

}
