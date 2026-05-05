import { FormEvent, useEffect, useState } from 'react';
import './App.css';

type Screen = 'home' | 'sessions' | 'new-session' | 'session' | 'new-expense';

type Expense = {
  id: number;
  title: string;
  amount: string;
  paidBy: string;
  splitBetween: string[];
};

type StoredSession = {
  id: string;
  name: string;
  participants: string[];
  expenses: Expense[];
  updatedAt: number;
};

type Balance = {
  member: string;
  amount: number;
};

type Transfer = {
  from: string;
  to: string;
  amount: number;
};

type TelegramUser = {
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramWebApp = {
  initDataUnsafe?: {
    user?: TelegramUser;
  };
  ready?: () => void;
  openTelegramLink?: (url: string) => void;
};

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

const sessionStoragePrefix = 'kto-platit-session-';
const sessionIndexKey = 'kto-platit-sessions-index';
const activeSessionKey = 'kto-platit-active-session-id';

const storageKey = (id: string) => `${sessionStoragePrefix}${id}`;

function generateSessionId() {
  let id = Math.random().toString(36).slice(2, 8);

  while (localStorage.getItem(storageKey(id))) {
    id = Math.random().toString(36).slice(2, 8);
  }

  return id;
}

function getSessionIdFromUrl() {
  const match = window.location.pathname.match(/^\/session\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : '';
}

function readSessionIds() {
  const ids = new Set<string>();
  const savedIds = localStorage.getItem(sessionIndexKey);

  if (savedIds) {
    try {
      const parsedIds = JSON.parse(savedIds) as unknown;

      if (Array.isArray(parsedIds)) {
        parsedIds.forEach((id) => {
          if (typeof id === 'string') {
            ids.add(id);
          }
        });
      }
    } catch {
      localStorage.removeItem(sessionIndexKey);
    }
  }

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);

    if (key?.startsWith(sessionStoragePrefix)) {
      ids.add(key.replace(sessionStoragePrefix, ''));
    }
  }

  return Array.from(ids);
}

function writeSessionIds(ids: string[]) {
  localStorage.setItem(sessionIndexKey, JSON.stringify(ids));
}

function readStoredSession(id: string): StoredSession | null {
  const savedSession = localStorage.getItem(storageKey(id));

  if (!savedSession) {
    return null;
  }

  try {
    const parsedSession = JSON.parse(savedSession) as Partial<StoredSession>;

    if (!parsedSession.id || !parsedSession.name) {
      return null;
    }

    return {
      id: parsedSession.id,
      name: parsedSession.name,
      participants: Array.isArray(parsedSession.participants)
        ? parsedSession.participants
        : [],
      expenses: Array.isArray(parsedSession.expenses)
        ? parsedSession.expenses
        : [],
      updatedAt: parsedSession.updatedAt ?? 0,
    };
  } catch {
    return null;
  }
}

function readAllStoredSessions() {
  const sessions = readSessionIds()
    .map((id) => readStoredSession(id))
    .filter((session): session is StoredSession => Boolean(session))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  writeSessionIds(sessions.map((session) => session.id));

  return sessions;
}

function saveStoredSession(session: StoredSession) {
  localStorage.setItem(storageKey(session.id), JSON.stringify(session));
  writeSessionIds([
    session.id,
    ...readSessionIds().filter((id) => id !== session.id),
  ]);
  localStorage.setItem(activeSessionKey, session.id);
}

function deleteStoredSession(id: string) {
  localStorage.removeItem(storageKey(id));
  writeSessionIds(readSessionIds().filter((sessionId) => sessionId !== id));

  if (localStorage.getItem(activeSessionKey) === id) {
    localStorage.removeItem(activeSessionKey);
  }
}

function calculateSettlements(members: string[], expenses: Expense[]) {
  const balances: Record<string, number> = {};

  members.forEach((member) => {
    balances[member] = 0;
  });

  expenses.forEach((expense) => {
    const amount = Number(expense.amount);

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !(expense.paidBy in balances) ||
      expense.splitBetween.length === 0
    ) {
      return;
    }

    balances[expense.paidBy] += amount;

    const share = amount / expense.splitBetween.length;

    expense.splitBetween.forEach((member) => {
      if (member in balances) {
        balances[member] -= share;
      }
    });
  });

  const balanceList: Balance[] = members.map((member) => ({
    member,
    amount: balances[member],
  }));

  const debtors = balanceList
    .filter((balance) => balance.amount < 0)
    .map((balance) => ({
      member: balance.member,
      amount: Math.abs(balance.amount),
    }));

  const creditors = balanceList
    .filter((balance) => balance.amount > 0)
    .map((balance) => ({
      member: balance.member,
      amount: balance.amount,
    }));

  const transfers: Transfer[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = Math.min(debtor.amount, creditor.amount);
    const roundedAmount = Math.round(amount);

    if (roundedAmount > 0) {
      transfers.push({
        from: debtor.member,
        to: creditor.member,
        amount: roundedAmount,
      });
    }

    debtor.amount -= amount;
    creditor.amount -= amount;

    if (debtor.amount < 0.01) {
      debtorIndex += 1;
    }

    if (creditor.amount < 0.01) {
      creditorIndex += 1;
    }
  }

  return {
    balances: balanceList.map((balance) => ({
      ...balance,
      amount: Math.round(balance.amount),
    })),
    transfers,
  };
}

function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [sessionId, setSessionId] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [draftSessionName, setDraftSessionName] = useState('');
  const [participantName, setParticipantName] = useState('');
  const [participants, setParticipants] = useState<string[]>([]);
  const [participantError, setParticipantError] = useState('');
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [savedSessions, setSavedSessions] = useState<StoredSession[]>([]);
  const [expenseTitle, setExpenseTitle] = useState('');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expensePaidBy, setExpensePaidBy] = useState('');
  const [expenseSplitBetween, setExpenseSplitBetween] = useState<string[]>([]);
  const [editingExpenseId, setEditingExpenseId] = useState<number | null>(null);
  const [shareMessage, setShareMessage] = useState('');
  const [isShareLinkVisible, setIsShareLinkVisible] = useState(false);
  const [telegramWebApp, setTelegramWebApp] = useState<TelegramWebApp | null>(
    null,
  );
  const [telegramDefaultName, setTelegramDefaultName] = useState('');

  const clearSessionState = () => {
    setSessionId('');
    setSessionName('');
    setParticipants([]);
    setExpenses([]);
    setParticipantName(telegramDefaultName);
    setParticipantError('');
    setShareMessage('');
    setIsShareLinkVisible(false);
  };

  const refreshSavedSessions = () => {
    setSavedSessions(readAllStoredSessions());
  };

  const openStoredSession = (id: string, shouldPushUrl = true) => {
    const storedSession = readStoredSession(id);

    if (!storedSession) {
      refreshSavedSessions();
      setScreen('sessions');
      return false;
    }

    setSessionId(storedSession.id);
    setSessionName(storedSession.name);
    setDraftSessionName(storedSession.name);
    setParticipants(storedSession.participants);
    setExpenses(storedSession.expenses);
    setParticipantName(telegramDefaultName);
    setParticipantError('');
    setShareMessage('');
    setIsShareLinkVisible(false);
    setScreen('session');
    localStorage.setItem(activeSessionKey, storedSession.id);
    refreshSavedSessions();

    if (shouldPushUrl) {
      window.history.pushState(null, '', `/session/${storedSession.id}`);
    }

    return true;
  };

  const openSessionsScreen = (shouldPushUrl = true) => {
    refreshSavedSessions();
    setScreen('sessions');
    setShareMessage('');
    setIsShareLinkVisible(false);

    if (shouldPushUrl) {
      window.history.pushState(null, '', '/');
    }
  };

  const openNewSessionScreen = () => {
    setDraftSessionName('');
    setScreen('new-session');
    window.history.pushState(null, '', '/');
  };

  useEffect(() => {
    const webApp = window.Telegram?.WebApp;

    if (!webApp) {
      return;
    }

    webApp.ready?.();
    setTelegramWebApp(webApp);

    const user = webApp.initDataUnsafe?.user;
    const defaultName =
      [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
      user?.username ||
      '';

    if (defaultName) {
      setTelegramDefaultName(defaultName);
      setParticipantName(defaultName);
    }
  }, []);

  useEffect(() => {
    const loadInitialScreen = () => {
      const idFromUrl = getSessionIdFromUrl();

      if (idFromUrl && openStoredSession(idFromUrl, false)) {
        return;
      }

      const activeSessionId = localStorage.getItem(activeSessionKey);

      if (activeSessionId && openStoredSession(activeSessionId, false)) {
        window.history.replaceState(null, '', `/session/${activeSessionId}`);
        return;
      }

      const sessions = readAllStoredSessions();
      setSavedSessions(sessions);

      if (sessions.length > 0) {
        setScreen('sessions');
      }
    };

    loadInitialScreen();

    const handlePopState = () => {
      const idFromUrl = getSessionIdFromUrl();

      if (idFromUrl) {
        openStoredSession(idFromUrl, false);
        return;
      }

      openSessionsScreen(false);
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    if (!sessionId || !sessionName) {
      return;
    }

    saveStoredSession({
      id: sessionId,
      name: sessionName,
      participants,
      expenses,
      updatedAt: Date.now(),
    });
    refreshSavedSessions();
  }, [sessionId, sessionName, participants, expenses]);

  const handleCreateSession = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const name = draftSessionName.trim();

    if (!name) {
      return;
    }

    const newSessionId = generateSessionId();

    setSessionId(newSessionId);
    setSessionName(name);
    setParticipants([]);
    setExpenses([]);
    setParticipantName(telegramDefaultName);
    setParticipantError('');
    setShareMessage('');
    setIsShareLinkVisible(false);
    setScreen('session');
    window.history.pushState(null, '', `/session/${newSessionId}`);
  };

  const handleAddParticipant = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const name = participantName.trim();

    if (!name) {
      setParticipantError('Введите имя участника');
      return;
    }

    const alreadyExists = participants.some(
      (participant) => participant.toLowerCase() === name.toLowerCase(),
    );

    if (alreadyExists) {
      setParticipantError('Такой участник уже есть');
      return;
    }

    setParticipants([...participants, name]);
    setParticipantName('');
    setParticipantError('');
  };

  const openNewExpenseScreen = () => {
    setExpenseTitle('');
    setExpenseAmount('');
    setExpensePaidBy(participants[0]);
    setExpenseSplitBetween(participants);
    setEditingExpenseId(null);
    setShareMessage('');
    setIsShareLinkVisible(false);
    setScreen('new-expense');
  };

  const openEditExpenseScreen = (expense: Expense) => {
    setExpenseTitle(expense.title);
    setExpenseAmount(expense.amount);
    setExpensePaidBy(expense.paidBy);
    setExpenseSplitBetween(expense.splitBetween);
    setEditingExpenseId(expense.id);
    setShareMessage('');
    setIsShareLinkVisible(false);
    setScreen('new-expense');
  };

  const handleToggleSplitParticipant = (participant: string) => {
    if (expenseSplitBetween.includes(participant)) {
      setExpenseSplitBetween(
        expenseSplitBetween.filter((name) => name !== participant),
      );
      return;
    }

    setExpenseSplitBetween([...expenseSplitBetween, participant]);
  };

  const handleSaveExpense = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const title = expenseTitle.trim();
    const amount = expenseAmount.trim();

    if (!title || !amount || !expensePaidBy || expenseSplitBetween.length === 0) {
      return;
    }

    const savedExpense: Expense = {
      id: editingExpenseId ?? Date.now(),
      title,
      amount,
      paidBy: expensePaidBy,
      splitBetween: expenseSplitBetween,
    };

    if (editingExpenseId) {
      setExpenses(
        expenses.map((expense) =>
          expense.id === editingExpenseId ? savedExpense : expense,
        ),
      );
    } else {
      setExpenses([...expenses, savedExpense]);
    }

    setEditingExpenseId(null);
    setScreen('session');
  };

  const handleCopyShareLink = async (shareText: string) => {
    if (!sessionId) {
      return;
    }

    const shareUrl = `${window.location.origin}/session/${sessionId}`;

    setIsShareLinkVisible(true);

    try {
      await navigator.clipboard.writeText(shareText);
      setShareMessage('Ссылка скопирована');
    } catch {
      setShareMessage(
        'Не получилось скопировать автоматически. Скопируйте ссылку вручную',
      );
    }
  };

  const handleShareWithFriends = () => {
    if (!sessionId) {
      return;
    }

    const shareUrl = `${window.location.origin}/session/${sessionId}`;
    const shareText = `Заходи в сессию «${sessionName}» — посчитаем, кто кому должен: ${shareUrl}`;

    setIsShareLinkVisible(true);

    if (telegramWebApp?.openTelegramLink) {
      const telegramShareUrl = `https://t.me/share/url?url=${encodeURIComponent(
        shareUrl,
      )}&text=${encodeURIComponent(shareText)}`;

      setShareMessage('');
      telegramWebApp.openTelegramLink(telegramShareUrl);
      return;
    }

    void handleCopyShareLink(shareText);
  };

  const handleDeleteSession = (id: string) => {
    const shouldDelete = window.confirm(
      'Удалить сессию? Это действие нельзя отменить.',
    );

    if (!shouldDelete) {
      return;
    }

    deleteStoredSession(id);
    const sessions = readAllStoredSessions();
    setSavedSessions(sessions);

    if (id === sessionId) {
      clearSessionState();
      setScreen('sessions');
      window.history.pushState(null, '', '/');
    }
  };

  const handleDeleteExpense = (id: number) => {
    const shouldDelete = window.confirm('Удалить расход?');

    if (!shouldDelete) {
      return;
    }

    setExpenses(expenses.filter((expense) => expense.id !== id));
  };

  const canAddExpense = participants.length >= 2;
  const settlements = calculateSettlements(participants, expenses);
  const shareUrl = sessionId ? `${window.location.origin}/session/${sessionId}` : '';

  return (
    <main className="app">
      {screen === 'home' && (
        <section className="screen" aria-label="Главный экран">
          <div className="screen__badge">Mini App</div>
          <h1>Кто платит</h1>
          <p>Разделяйте траты с друзьями без таблиц и споров</p>
          <button type="button" onClick={openNewSessionScreen}>
            Создать сессию
          </button>
          {savedSessions.length > 0 && (
            <button
              className="secondary-button"
              type="button"
              onClick={() => openSessionsScreen()}
            >
              Все сессии
            </button>
          )}
        </section>
      )}

      {screen === 'sessions' && (
        <section className="screen screen--session" aria-label="Все сессии">
          <h1>Мои сессии</h1>

          {savedSessions.length === 0 ? (
            <p>Пока нет сохранённых сессий</p>
          ) : (
            <ul className="session-list">
              {savedSessions.map((savedSession) => (
                <li className="session-card" key={savedSession.id}>
                  <h2>{savedSession.name}</h2>
                  <p>
                    Участников: {savedSession.participants.length} · Расходов:{' '}
                    {savedSession.expenses.length}
                  </p>
                  <div className="session-actions">
                    <button
                      type="button"
                      onClick={() => openStoredSession(savedSession.id)}
                    >
                      Открыть
                    </button>
                    <button
                      className="danger-button"
                      type="button"
                      onClick={() => handleDeleteSession(savedSession.id)}
                    >
                      Удалить
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <button type="button" onClick={openNewSessionScreen}>
            Создать новую сессию
          </button>
        </section>
      )}

      {screen === 'new-session' && (
        <section className="screen" aria-label="Создание сессии">
          <h1>Новая сессия</h1>
          <form className="session-form" onSubmit={handleCreateSession}>
            <label htmlFor="session-name">
              Название (например: Вечер, Поездка, Ресторан)
            </label>
            <input
              id="session-name"
              type="text"
              value={draftSessionName}
              onChange={(event) => setDraftSessionName(event.target.value)}
              placeholder="Вечер"
              autoFocus
            />
            <button type="submit">Создать</button>
          </form>
        </section>
      )}

      {screen === 'session' && (
        <section className="screen screen--session" aria-label="Экран сессии">
          <div className="screen__badge">Сессия</div>
          <h1>{sessionName}</h1>
          <button
            className="secondary-button"
            type="button"
            onClick={() => openSessionsScreen()}
          >
            Все сессии
          </button>
          <button type="button" onClick={handleShareWithFriends}>
            Поделиться с друзьями
          </button>
          {shareMessage && (
            <p
              className={
                shareMessage === 'Ссылка скопирована'
                  ? 'success-text'
                  : 'helper-text'
              }
            >
              {shareMessage}
            </p>
          )}
          {isShareLinkVisible && (
            <div className="share-link">
              <h2>Ссылка на сессию</h2>
              <input type="text" value={shareUrl} readOnly />
            </div>
          )}

          {expenses.length === 0 ? (
            <p>Пока нет расходов</p>
          ) : (
            <div className="expenses">
              <h2>Расходы</h2>
              <ul className="expense-list">
                {expenses.map((expense) => (
                  <li key={expense.id}>
                    <p>
                      {expense.title} — {expense.amount} ₽ — заплатил{' '}
                      {expense.paidBy} — делим на:{' '}
                      {expense.splitBetween.join(', ')}
                    </p>
                    <div className="expense-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => openEditExpenseScreen(expense)}
                      >
                        Редактировать
                      </button>
                      <button
                        className="danger-button"
                        type="button"
                        onClick={() => handleDeleteExpense(expense.id)}
                      >
                        Удалить
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="summary">
            <h2>Итог</h2>

            {expenses.length === 0 ? (
              <p className="helper-text">
                Добавьте первый расход, чтобы увидеть итог
              </p>
            ) : (
              <>
                <h3>Балансы</h3>
                <ul className="balance-list">
                  {settlements.balances.map((balance) => (
                    <li key={balance.member}>
                      <span>{balance.member}</span>
                      <span
                        className={
                          balance.amount > 0
                            ? 'balance-positive'
                            : balance.amount < 0
                              ? 'balance-negative'
                              : ''
                        }
                      >
                        {balance.amount > 0 ? '+' : ''}
                        {balance.amount} ₽
                      </span>
                    </li>
                  ))}
                </ul>

                <h3>Кто кому должен</h3>
                {settlements.transfers.length === 0 ? (
                  <p className="helper-text">Все уже в расчёте</p>
                ) : (
                  <ul className="transfer-list">
                    {settlements.transfers.map((transfer) => (
                      <li key={`${transfer.from}-${transfer.to}`}>
                        {transfer.from} платит {transfer.to}{' '}
                        {transfer.amount} ₽
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>

          <div className="participants">
            <h2>Участники</h2>
            <form className="participant-form" onSubmit={handleAddParticipant}>
              <label htmlFor="participant-name">Имя участника</label>
              <div className="participant-form__row">
                <input
                  id="participant-name"
                  type="text"
                  value={participantName}
                  onChange={(event) => {
                    setParticipantName(event.target.value);
                    setParticipantError('');
                  }}
                  placeholder="Анна"
                />
                <button type="submit">Добавить</button>
              </div>
              {participantError && (
                <p className="form-error">{participantError}</p>
              )}
            </form>

            {participants.length > 0 && (
              <ul className="participant-list">
                {participants.map((participant) => (
                  <li key={participant}>{participant}</li>
                ))}
              </ul>
            )}
          </div>

          {!canAddExpense && (
            <p className="helper-text">
              Добавьте минимум двух участников, чтобы начать делить расходы
            </p>
          )}
          <button
            type="button"
            disabled={!canAddExpense}
            onClick={openNewExpenseScreen}
          >
            Добавить расход
          </button>
        </section>
      )}

      {screen === 'new-expense' && (
        <section className="screen screen--session" aria-label="Новый расход">
          <h1>{editingExpenseId ? 'Редактировать расход' : 'Новый расход'}</h1>
          <form className="expense-form" onSubmit={handleSaveExpense}>
            <label htmlFor="expense-title">Название</label>
            <input
              id="expense-title"
              type="text"
              value={expenseTitle}
              onChange={(event) => setExpenseTitle(event.target.value)}
              placeholder="Пицца"
              autoFocus
              required
            />

            <label htmlFor="expense-amount">Сумма</label>
            <input
              id="expense-amount"
              type="number"
              min="1"
              inputMode="decimal"
              value={expenseAmount}
              onChange={(event) => setExpenseAmount(event.target.value)}
              placeholder="1200"
              required
            />

            <label htmlFor="expense-paid-by">Кто заплатил</label>
            <select
              id="expense-paid-by"
              value={expensePaidBy}
              onChange={(event) => setExpensePaidBy(event.target.value)}
              required
            >
              {participants.map((participant) => (
                <option key={participant} value={participant}>
                  {participant}
                </option>
              ))}
            </select>

            <fieldset className="split-fieldset">
              <legend>За кого делим</legend>
              {participants.map((participant) => (
                <label className="checkbox-row" key={participant}>
                  <input
                    type="checkbox"
                    checked={expenseSplitBetween.includes(participant)}
                    onChange={() => handleToggleSplitParticipant(participant)}
                  />
                  {participant}
                </label>
              ))}
            </fieldset>

            <button type="submit">
              {editingExpenseId ? 'Сохранить изменения' : 'Сохранить расход'}
            </button>
          </form>
        </section>
      )}
    </main>
  );
}

export default App;
