import { FormEvent, useEffect, useState } from 'react';
import './App.css';
import { supabase } from './lib/supabase';

type Screen =
  | 'home'
  | 'sessions'
  | 'new-session'
  | 'session'
  | 'new-expense'
  | 'not-found';

type Expense = {
  id: number | string;
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

type SessionRow = {
  id: string;
  name: string;
};

type ParticipantRow = {
  name: string;
};

type ExpenseRow = {
  id: number | string;
  title: string;
  amount: number | string;
  paid_by: string;
  participants: string[];
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

const recentSessionIdsKey = 'kto-platit-recent-session-ids';
const activeSessionKey = 'kto-platit-active-session-id';
const publicAppUrl = 'https://kto-platit-delta.vercel.app';

function generateSessionId() {
  return Math.random().toString(36).slice(2, 8);
}

function getSessionIdFromUrl() {
  const match = window.location.pathname.match(/^\/session\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : '';
}

function readRecentSessionIds() {
  const savedIds = localStorage.getItem(recentSessionIdsKey);

  if (savedIds) {
    try {
      const parsedIds = JSON.parse(savedIds) as unknown;

      if (Array.isArray(parsedIds)) {
        return parsedIds.filter((id): id is string => typeof id === 'string');
      }
    } catch {
      localStorage.removeItem(recentSessionIdsKey);
    }
  }

  return [];
}

function saveRecentSessionId(id: string) {
  localStorage.setItem(
    recentSessionIdsKey,
    JSON.stringify([
      id,
      ...readRecentSessionIds().filter((sessionId) => sessionId !== id),
    ]),
  );
  localStorage.setItem(activeSessionKey, id);
}

function removeRecentSessionId(id: string) {
  localStorage.setItem(
    recentSessionIdsKey,
    JSON.stringify(readRecentSessionIds().filter((sessionId) => sessionId !== id)),
  );

  if (localStorage.getItem(activeSessionKey) === id) {
    localStorage.removeItem(activeSessionKey);
  }
}

function normalizeStoredSession(
  session: SessionRow,
  participants: ParticipantRow[],
  expenses: ExpenseRow[],
): StoredSession {
  return {
    id: session.id,
    name: session.name,
    participants: participants.map((participant) => participant.name),
    expenses: expenses.map((expense) => ({
      id: expense.id,
      title: expense.title,
      amount: String(expense.amount),
      paidBy: expense.paid_by,
      splitBetween: Array.isArray(expense.participants)
        ? expense.participants
        : [],
    })),
    updatedAt: Date.now(),
  };
}

async function loadSessionFromSupabase(id: string) {
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('id, name')
    .eq('id', id)
    .single<SessionRow>();

  if (sessionError || !session) {
    return null;
  }

  const [
    { data: participants, error: participantsError },
    { data: expenses, error: expensesError },
  ] = await Promise.all([
    supabase
      .from('participants')
      .select('name')
      .eq('session_id', id)
      .order('name'),
    supabase
      .from('expenses')
      .select('id, title, amount, paid_by, participants')
      .eq('session_id', id)
      .order('id'),
  ]);

  if (participantsError || expensesError) {
    throw participantsError || expensesError;
  }

  return normalizeStoredSession(
    session,
    (participants ?? []) as ParticipantRow[],
    (expenses ?? []) as ExpenseRow[],
  );
}

async function loadRecentSessionsFromSupabase() {
  const sessions = await Promise.all(
    readRecentSessionIds().map((id) => loadSessionFromSupabase(id)),
  );

  return sessions.filter((session): session is StoredSession => Boolean(session));
}

async function deleteSessionFromSupabase(id: string) {
  await supabase.from('expenses').delete().eq('session_id', id);
  await supabase.from('participants').delete().eq('session_id', id);
  await supabase.from('sessions').delete().eq('id', id);
  removeRecentSessionId(id);
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

function formatMoney(amount: number | string, showPlus = false) {
  const value = Math.round(Number(amount));
  const sign = showPlus && value > 0 ? '+' : '';
  const formattedValue = new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 0,
  }).format(value);

  return `${sign}${formattedValue} ₽`;
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
  const [editingExpenseId, setEditingExpenseId] = useState<
    number | string | null
  >(null);
  const [shareMessage, setShareMessage] = useState('');
  const [telegramWebApp, setTelegramWebApp] = useState<TelegramWebApp | null>(
    null,
  );
  const [telegramDefaultName, setTelegramDefaultName] = useState('');
  const [isCreatingSession, setIsCreatingSession] = useState(false);

  const clearSessionState = () => {
    setSessionId('');
    setSessionName('');
    setParticipants([]);
    setExpenses([]);
    setParticipantName(telegramDefaultName);
    setParticipantError('');
    setShareMessage('');
  };

  const applySession = (storedSession: StoredSession) => {
    setSessionId(storedSession.id);
    setSessionName(storedSession.name);
    setDraftSessionName(storedSession.name);
    setParticipants(storedSession.participants);
    setExpenses(storedSession.expenses);
    setParticipantName(telegramDefaultName);
    setParticipantError('');
    setShareMessage('');
    setScreen('session');
    saveRecentSessionId(storedSession.id);
  };

  const refreshSavedSessions = async () => {
    setSavedSessions(await loadRecentSessionsFromSupabase());
  };

  const reloadActiveSession = async () => {
    if (!sessionId) {
      return;
    }

    const storedSession = await loadSessionFromSupabase(sessionId);

    if (storedSession) {
      applySession(storedSession);
      await refreshSavedSessions();
    }
  };

  const openStoredSession = async (id: string, shouldPushUrl = true) => {
    const storedSession = await loadSessionFromSupabase(id);

    if (!storedSession) {
      removeRecentSessionId(id);
      await refreshSavedSessions();
      setScreen('sessions');
      return false;
    }

    applySession(storedSession);
    await refreshSavedSessions();

    if (shouldPushUrl) {
      window.history.pushState(null, '', `/session/${storedSession.id}`);
    }

    return true;
  };

  const openSessionsScreen = async (shouldPushUrl = true) => {
    await refreshSavedSessions();
    setScreen('sessions');
    setShareMessage('');

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
    const loadInitialScreen = async () => {
      const idFromUrl = getSessionIdFromUrl();

      if (idFromUrl) {
        const sessionFromUrl = await loadSessionFromSupabase(idFromUrl);

        if (sessionFromUrl) {
          applySession(sessionFromUrl);
          await refreshSavedSessions();
        } else {
          setScreen('not-found');
        }

        return;
      }

      const activeSessionId = localStorage.getItem(activeSessionKey);

      if (activeSessionId && (await openStoredSession(activeSessionId, false))) {
        window.history.replaceState(null, '', `/session/${activeSessionId}`);
        return;
      }

      const sessions = await loadRecentSessionsFromSupabase();
      setSavedSessions(sessions);

      if (sessions.length > 0) {
        setScreen('sessions');
      }
    };

    void loadInitialScreen();

    const handlePopState = () => {
      const idFromUrl = getSessionIdFromUrl();

      if (idFromUrl) {
        void (async () => {
          const sessionFromUrl = await loadSessionFromSupabase(idFromUrl);

          if (sessionFromUrl) {
            applySession(sessionFromUrl);
            await refreshSavedSessions();
          } else {
            setScreen('not-found');
          }
        })();
        return;
      }

      void openSessionsScreen(false);
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  const handleCreateSession = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    console.log('create session clicked');

    if (isCreatingSession) {
      console.log('create session ignored: request already in progress');
      return;
    }

    const name = draftSessionName.trim();
    console.log('session name:', name);

    if (!name) {
      window.alert('Введите название сессии');
      return;
    }

    setIsCreatingSession(true);

    const newSessionId = generateSessionId();
    console.log('sessionId:', newSessionId);
    const payload = { id: newSessionId, name };
    console.log('sessions insert payload:', payload);

    try {
      const { data, error } = await supabase.from('sessions').insert(payload);
      console.log('supabase insert result', { data, error });

      if (error) {
        console.error(error);

        window.alert(
          'Ошибка Supabase:\n' +
            'message: ' +
            error.message +
            '\n' +
            'details: ' +
            (error.details || '-') +
            '\n' +
            'hint: ' +
            (error.hint || '-') +
            '\n' +
            'code: ' +
            (error.code || '-'),
        );
        return;
      }

      saveRecentSessionId(newSessionId);
      applySession({
        id: newSessionId,
        name,
        participants: [],
        expenses: [],
        updatedAt: Date.now(),
      });
      window.history.pushState(null, '', `/session/${newSessionId}`);

      const storedSession = await loadSessionFromSupabase(newSessionId);

      if (storedSession) {
        applySession(storedSession);
      }

      await refreshSavedSessions();
    } catch (err) {
      console.error('create session exception', err);
      window.alert(JSON.stringify(err, null, 2));
    } finally {
      setIsCreatingSession(false);
    }
  };

  const handleAddParticipant = async (event: FormEvent<HTMLFormElement>) => {
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

    const { error } = await supabase
      .from('participants')
      .insert({ session_id: sessionId, name });

    if (error) {
      window.alert('Не получилось добавить участника в Supabase');
      return;
    }

    setParticipantName('');
    setParticipantError('');
    await reloadActiveSession();
  };

  const openNewExpenseScreen = () => {
    setExpenseTitle('');
    setExpenseAmount('');
    setExpensePaidBy(participants[0]);
    setExpenseSplitBetween(participants);
    setEditingExpenseId(null);
    setShareMessage('');
    setScreen('new-expense');
  };

  const openEditExpenseScreen = (expense: Expense) => {
    setExpenseTitle(expense.title);
    setExpenseAmount(expense.amount);
    setExpensePaidBy(expense.paidBy);
    setExpenseSplitBetween(expense.splitBetween);
    setEditingExpenseId(expense.id);
    setShareMessage('');
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

  const handleSaveExpense = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const title = expenseTitle.trim();
    const amount = expenseAmount.trim();

    if (!title || !amount || !expensePaidBy || expenseSplitBetween.length === 0) {
      return;
    }

    const savedExpense = {
      session_id: sessionId,
      title,
      amount,
      paid_by: expensePaidBy,
      participants: expenseSplitBetween,
    };

    let error = null;

    if (editingExpenseId !== null) {
      const response = await supabase
        .from('expenses')
        .update(savedExpense)
        .eq('id', editingExpenseId)
        .eq('session_id', sessionId);

      error = response.error;
    } else {
      const response = await supabase.from('expenses').insert(savedExpense);

      error = response.error;
    }

    if (error) {
      window.alert('Не получилось сохранить расход в Supabase');
      return;
    }

    setEditingExpenseId(null);
    await reloadActiveSession();
  };

  const handleCopyShareLink = async (shareText: string) => {
    if (!sessionId) {
      return;
    }

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

    const shareUrl = `${publicAppUrl}/session/${sessionId}`;
    const shareText = `Заходи в сессию «${sessionName}» — посмотрим, кто кому должен 👇`;
    const fallbackShareText = `${shareText}\n${shareUrl}`;

    if (telegramWebApp?.openTelegramLink) {
      const telegramShareUrl = `https://t.me/share/url?url=${encodeURIComponent(
        shareUrl,
      )}&text=${encodeURIComponent(shareText)}`;

      setShareMessage('');
      telegramWebApp.openTelegramLink(telegramShareUrl);
      return;
    }

    void handleCopyShareLink(fallbackShareText);
  };

  const handleDeleteSession = async (id: string) => {
    const shouldDelete = window.confirm(
      'Удалить сессию? Это действие нельзя отменить.',
    );

    if (!shouldDelete) {
      return;
    }

    await deleteSessionFromSupabase(id);
    const sessions = await loadRecentSessionsFromSupabase();
    setSavedSessions(sessions);

    if (id === sessionId) {
      if (sessions.length > 0) {
        applySession(sessions[0]);
        window.history.pushState(null, '', `/session/${sessions[0].id}`);
      } else {
        clearSessionState();
        setScreen('sessions');
        window.history.pushState(null, '', '/');
      }
    }
  };

  const handleDeleteExpense = async (id: number | string) => {
    const shouldDelete = window.confirm('Удалить расход?');

    if (!shouldDelete) {
      return;
    }

    const { error } = await supabase
      .from('expenses')
      .delete()
      .eq('id', id)
      .eq('session_id', sessionId);

    if (error) {
      window.alert('Не получилось удалить расход в Supabase');
      return;
    }

    await reloadActiveSession();
  };

  const canAddExpense = participants.length >= 2;
  const settlements = calculateSettlements(participants, expenses);

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
              onClick={() => void openSessionsScreen()}
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
                      onClick={() => void openStoredSession(savedSession.id)}
                    >
                      Открыть
                    </button>
                    <button
                      className="danger-button"
                      type="button"
                      onClick={() => void handleDeleteSession(savedSession.id)}
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

      {screen === 'not-found' && (
        <section className="screen" aria-label="Сессия не найдена">
          <h1>Сессия не найдена</h1>
          <p>Проверьте ссылку или попросите отправить её ещё раз.</p>
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
            <button type="submit" disabled={isCreatingSession}>
              {isCreatingSession ? 'Создаём...' : 'Создать'}
            </button>
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
            onClick={() => void openSessionsScreen()}
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
          {expenses.length === 0 ? (
            <p>Пока нет расходов</p>
          ) : (
            <div className="expenses">
              <h2>Расходы</h2>
              <ul className="expense-list">
                {expenses.map((expense) => (
                  <li key={expense.id}>
                    <p>
                      {expense.title} — {formatMoney(expense.amount)} — заплатил{' '}
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
                        onClick={() => void handleDeleteExpense(expense.id)}
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
                        {formatMoney(balance.amount, true)}
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
                        {transfer.from} → {transfer.to}:{' '}
                        {formatMoney(transfer.amount)}
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
          <h1>
            {editingExpenseId !== null ? 'Редактировать расход' : 'Новый расход'}
          </h1>
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
              {editingExpenseId !== null
                ? 'Сохранить изменения'
                : 'Сохранить расход'}
            </button>
          </form>
        </section>
      )}
    </main>
  );
}

export default App;
