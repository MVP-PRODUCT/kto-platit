import { FormEvent, useEffect, useState } from 'react';
import './App.css';

type Screen = 'home' | 'new-session' | 'session' | 'new-expense';

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
  close?: () => void;
  openTelegramLink?: (url: string) => void;
};

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

const storageKey = (id: string) => `kto-platit-session-${id}`;

function generateSessionId() {
  return Math.random().toString(36).slice(2, 8);
}

function getSessionIdFromUrl() {
  const match = window.location.pathname.match(/^\/session\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : '';
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
  const [expenseTitle, setExpenseTitle] = useState('');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expensePaidBy, setExpensePaidBy] = useState('');
  const [expenseSplitBetween, setExpenseSplitBetween] = useState<string[]>([]);
  const [shareMessage, setShareMessage] = useState('');
  const [isShareLinkVisible, setIsShareLinkVisible] = useState(false);
  const [telegramWebApp, setTelegramWebApp] = useState<TelegramWebApp | null>(
    null,
  );
  const [telegramDefaultName, setTelegramDefaultName] = useState('');

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
    const loadSessionFromUrl = () => {
      const idFromUrl = getSessionIdFromUrl();

      if (!idFromUrl) {
        return;
      }

      const savedSession = localStorage.getItem(storageKey(idFromUrl));

      if (!savedSession) {
        return;
      }

      const parsedSession = JSON.parse(savedSession) as StoredSession;

      setSessionId(parsedSession.id);
      setSessionName(parsedSession.name);
      setDraftSessionName(parsedSession.name);
      setParticipants(parsedSession.participants);
      setExpenses(parsedSession.expenses);
      setScreen('session');
    };

    loadSessionFromUrl();
    window.addEventListener('popstate', loadSessionFromUrl);

    return () => {
      window.removeEventListener('popstate', loadSessionFromUrl);
    };
  }, []);

  useEffect(() => {
    if (!sessionId || !sessionName) {
      return;
    }

    const session: StoredSession = {
      id: sessionId,
      name: sessionName,
      participants,
      expenses,
    };

    localStorage.setItem(storageKey(sessionId), JSON.stringify(session));
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

    setExpenses([
      ...expenses,
      {
        id: Date.now(),
        title,
        amount,
        paidBy: expensePaidBy,
        splitBetween: expenseSplitBetween,
      },
    ]);
    setScreen('session');
  };

  const handleShareSession = async () => {
    if (!sessionId) {
      return;
    }

    const shareUrl = `${window.location.origin}/session/${sessionId}`;

    setIsShareLinkVisible(true);

    try {
      await navigator.clipboard.writeText(shareUrl);
      setShareMessage('Ссылка скопирована');
    } catch {
      setShareMessage('Не получилось скопировать автоматически. Скопируйте ссылку вручную');
    }
  };

  const handleTelegramShareSession = () => {
    if (!sessionId) {
      return;
    }

    const shareUrl = `${window.location.origin}/session/${sessionId}`;

    setIsShareLinkVisible(true);
    setShareMessage('');

    if (!telegramWebApp?.openTelegramLink) {
      void handleShareSession();
      return;
    }

    const telegramShareUrl = `https://t.me/share/url?url=${encodeURIComponent(
      shareUrl,
    )}&text=${encodeURIComponent('Сессия “Кто платит”')}`;

    telegramWebApp.openTelegramLink(telegramShareUrl);
  };

  const handleCloseTelegramApp = () => {
    telegramWebApp?.close?.();
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
          <button type="button" onClick={() => setScreen('new-session')}>
            Создать сессию
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
          <button type="button" onClick={handleShareSession}>
            Поделиться
          </button>
          {telegramWebApp && (
            <>
              <button type="button" onClick={handleTelegramShareSession}>
                Поделиться в Telegram
              </button>
              <button type="button" onClick={handleCloseTelegramApp}>
                Закрыть
              </button>
            </>
          )}
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
                    {expense.title} — {expense.amount} ₽ — заплатил{' '}
                    {expense.paidBy} — делим на:{' '}
                    {expense.splitBetween.join(', ')}
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
          <h1>Новый расход</h1>
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

            <button type="submit">Сохранить расход</button>
          </form>
        </section>
      )}
    </main>
  );
}

export default App;
