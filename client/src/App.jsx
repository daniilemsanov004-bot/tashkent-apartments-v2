import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase, supabaseConfigMissing } from './lib/supabaseClient.js';

const REFRESH_MS = 15000;

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `${days} дн назад`;
}

function badgeFor(listing) {
  if (listing.label_kind === 'owner') return { cls: 'badge-owner', text: '✓ Собственник' };
  if (listing.label_kind === 'unchecked') return { cls: 'badge-unchecked', text: `🙂 ${listing.label_text || 'Собственник'}` };
  if (listing.label_kind === 'agent') return { cls: 'badge-agent', text: `🏢 ${listing.label_text || 'Агентство'}` };
  return { cls: 'badge-unsure', text: '? Сомнительно' };
}

function dealTag(dealType) {
  if (dealType === 'sale') return <span className="deal-tag deal-sale">Продажа</span>;
  if (dealType === 'rent') return <span className="deal-tag deal-rent">Аренда</span>;
  return null;
}

function propertyTypeLabel(propertyType) {
  if (propertyType === 'house') return '🏡 Дом';
  if (propertyType === 'commercial') return '🏢 Коммерция';
  return '🏠 Квартира';
}

function Card({ listing, onToggleContacted }) {
  const badge = badgeFor(listing);
  return (
    <div className={`card ${listing.contacted ? 'is-contacted' : ''}`}>
      <div className="card-top">
        <div>
          <p className="card-title">
            <a href={listing.url} target="_blank" rel="noreferrer">{listing.title}</a>
          </p>
          <p className="card-meta">
            {dealTag(listing.deal_type)}
            <span className="source-tag">{propertyTypeLabel(listing.property_type)}</span>
            <span className="source-tag">{listing.source}</span>
            &nbsp;·&nbsp;{timeAgo(listing.created_at)}
            {listing.district ? ` · 📍 ${listing.district}` : ''}
            {listing.assigned_to ? ` · 👤 Взял: ${listing.assigned_to}` : ''}
          </p>
        </div>
        <span className={`badge ${badge.cls}`}>{badge.text}</span>
      </div>
      <div className="card-bottom">
        <span className="price">{listing.price || 'цена не указана'}</span>
        <div className="card-actions">
          <button
            className={`btn btn-contact ${listing.contacted ? 'is-on' : ''}`}
            onClick={() => onToggleContacted(listing.id, !listing.contacted)}
          >
            {listing.contacted ? '✓ Связались' : 'Отметить связь'}
          </button>
          {listing.phone && (
            <>
              <a className="btn" href={`https://wa.me/${listing.phone.replace(/[^\d]/g, '')}`} target="_blank" rel="noreferrer">WhatsApp</a>
              <a className="btn" href={`tel:${listing.phone}`}>Позвонить</a>
            </>
          )}
          <a className="btn btn-primary" href={listing.url} target="_blank" rel="noreferrer">Открыть</a>
        </div>
      </div>
    </div>
  );
}

// ---------- Экран входа ----------

function LoginScreen() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const sendLink = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const { error: authError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setLoading(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    setSent(true);
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="eyebrow">Ташкент · недвижимость</div>
        <h1>Вход в систему</h1>
        {sent ? (
          <p className="auth-hint">
            Ссылка для входа отправлена на <b>{email}</b>. Откройте почту и перейдите по ссылке —
            вернётесь сюда уже авторизованным.
          </p>
        ) : (
          <form onSubmit={sendLink}>
            <input
              type="email"
              required
              placeholder="ваш email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button className="btn btn-primary" type="submit" disabled={loading}>
              {loading ? 'Отправляю…' : 'Получить ссылку для входа'}
            </button>
            {error && <p className="auth-error">{error}</p>}
          </form>
        )}
        <p className="auth-footnote">
          Доступ есть только у приглашённых. Если вас ещё не добавили — попросите
          кого-то из команды пригласить ваш email.
        </p>
      </div>
    </div>
  );
}

function NotAuthorizedScreen({ email, onSignOut }) {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="eyebrow">Ташкент · недвижимость</div>
        <h1>Нет доступа</h1>
        <p className="auth-hint">
          Вы вошли как <b>{email}</b>, но этого email нет в списке команды.
          Попросите кого-то, у кого уже есть доступ, пригласить вас.
        </p>
        <button className="btn" onClick={onSignOut}>Выйти</button>
      </div>
    </div>
  );
}

// ---------- Панель команды ----------

function TeamPanel({ authFetch, myEmail: myEmailRaw, onClose }) {
  const myEmail = (myEmailRaw || '').toLowerCase();
  const [members, setMembers] = useState([]);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState('admin');
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    const res = await authFetch('/api/team');
    if (res?.ok) setMembers(await res.json());
  }, [authFetch]);

  useEffect(() => { load(); }, [load]);

  // Я — владелец? Только владелец видит элементы управления
  // (приглашение, смена роли, удаление); список видят все.
  const myRole = members.find((m) => m.email === myEmail)?.role;
  const iAmOwner = myRole === 'owner';
  const ownerCount = members.filter((m) => m.role === 'owner').length;

  const invite = async (e) => {
    e.preventDefault();
    setStatus('Приглашаю…');
    const res = await authFetch('/api/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: newEmail.trim(), role: newRole }),
    });
    if (res?.ok) {
      setStatus('Готово ✓');
      setNewEmail('');
      setNewRole('admin');
      load();
    } else {
      setStatus('Не получилось — проверьте email');
    }
  };

  const changeRole = async (email, role) => {
    setStatus('Меняю роль…');
    const res = await authFetch('/api/team', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role }),
    });
    if (res?.ok) {
      setStatus('Готово ✓');
      load();
    } else {
      const body = await res?.json().catch(() => null);
      setStatus(body?.error || 'Не получилось сменить роль');
    }
  };

  const removeMember = async (email) => {
    if (!window.confirm(`Убрать ${email} из команды?`)) return;
    setStatus('Удаляю…');
    const res = await authFetch('/api/team', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (res?.ok) {
      setStatus('Готово ✓');
      load();
    } else {
      const body = await res?.json().catch(() => null);
      setStatus(body?.error || 'Не получилось удалить');
    }
  };

  return (
    <div className="team-panel">
      <div className="team-panel-header">
        <h3>Команда</h3>
        <button className="btn" onClick={onClose}>Закрыть</button>
      </div>
      <ul className="team-list">
        {members.map((m) => {
          const isLastOwner = m.role === 'owner' && ownerCount <= 1;
          return (
            <li key={m.email} className="team-list-row">
              <span>
                {m.email} {m.email === myEmail && <span className="you-tag">это вы</span>}
              </span>
              <span className="team-list-row-right">
                <span className={`role-badge role-badge-${m.role}`}>
                  {m.role === 'owner' ? 'владелец' : 'админ'}
                </span>
                {iAmOwner && (
                  <>
                    {m.role === 'admin' ? (
                      <button className="btn btn-small" onClick={() => changeRole(m.email, 'owner')}>
                        Сделать владельцем
                      </button>
                    ) : (
                      <button
                        className="btn btn-small"
                        disabled={isLastOwner}
                        title={isLastOwner ? 'Нельзя — это последний владелец' : undefined}
                        onClick={() => changeRole(m.email, 'admin')}
                      >
                        Сделать админом
                      </button>
                    )}
                    <button
                      className="btn btn-small btn-danger"
                      disabled={isLastOwner}
                      title={isLastOwner ? 'Нельзя — это последний владелец' : undefined}
                      onClick={() => removeMember(m.email)}
                    >
                      Убрать
                    </button>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {iAmOwner && (
        <form onSubmit={invite} className="team-invite-form">
          <input
            type="email"
            required
            placeholder="email нового человека"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
          />
          <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
            <option value="admin">Админ</option>
            <option value="owner">Владелец</option>
          </select>
          <button className="btn btn-primary" type="submit">Пригласить</button>
        </form>
      )}
      {status && <p className="auth-hint">{status}</p>}
    </div>
  );
}

// ---------- Основной дашборд ----------

export default function App() {
  if (supabaseConfigMissing) {
    return (
      <div className="config-error">
        <h2>⚠️ Сайт не настроен</h2>
        <p>
          Не заданы переменные окружения <code>VITE_SUPABASE_URL</code> и{' '}
          <code>VITE_SUPABASE_ANON_KEY</code>.
        </p>
        <p>
          В Vercel: Project Settings → Environment Variables — добавьте обе,
          затем сделайте <b>Redeploy</b> (одного добавления переменной
          недостаточно, нужна пересборка). Значения — в Supabase → Project
          Settings → API Keys (anon public ключ).
        </p>
      </div>
    );
  }

  return <Dashboard />;
}

function Dashboard() {
  const [session, setSession] = useState(undefined); // undefined = ещё проверяем
  const [authorized, setAuthorized] = useState(null); // null = не проверено, true/false после первого запроса
  const [showTeam, setShowTeam] = useState(false);

  const [listings, setListings] = useState([]);
  const [statusText, setStatusText] = useState('Загрузка…');
  const [search, setSearch] = useState('');
  const [dealFilter, setDealFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [badgeFilter, setBadgeFilter] = useState('all');
  const [contactedFilter, setContactedFilter] = useState('all');
  const [daysRange, setDaysRange] = useState('3');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => listener.subscription.unsubscribe();
  }, []);

  const authFetch = useCallback(
    async (url, options = {}) => {
      if (!session?.access_token) return null;
      const res = await fetch(url, {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      if (res.status === 401) {
        setAuthorized(false);
        return null;
      }
      setAuthorized(true);
      return res;
    },
    [session]
  );

  const fetchListings = useCallback(async () => {
    const res = await authFetch(`/api/listings?days=${daysRange}`);
    if (!res) return;
    try {
      const data = await res.json();
      setListings(data);
      setStatusText('Обновлено ' + new Date().toLocaleTimeString('ru-RU'));
    } catch (err) {
      setStatusText('Не удалось связаться с сервером');
    }
  }, [authFetch, daysRange]);

  useEffect(() => {
    if (!session) return;
    fetchListings();
    const id = setInterval(fetchListings, REFRESH_MS);
    return () => clearInterval(id);
  }, [session, fetchListings]);

  const toggleContacted = useCallback(async (id, next) => {
    setListings((prev) => prev.map((l) => (l.id === id ? { ...l, contacted: next } : l)));
    await authFetch(`/api/contacted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, contacted: next }),
    });
  }, [authFetch]);

  const clearAll = useCallback(async () => {
    const confirmed = window.confirm(
      'Удалить все объявления из базы? Это нельзя отменить. При следующей проверке сегодняшние объявления придут заново.'
    );
    if (!confirmed) return;
    const res = await authFetch('/api/clear', { method: 'POST' });
    if (res?.ok) setListings([]);
  }, [authFetch]);

  const resetFilters = useCallback(() => {
    setSearch('');
    setDealFilter('all');
    setTypeFilter('all');
    setBadgeFilter('all');
    setContactedFilter('all');
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return listings.filter((l) => {
      if (q) {
        const haystack = `${l.title} ${l.district || ''} ${l.raw_text || ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (badgeFilter === 'owner' && l.label_kind !== 'owner') return false;
      if (badgeFilter === 'unsure' && l.label_kind !== 'uncertain') return false;
      if (dealFilter !== 'all' && l.deal_type !== dealFilter) return false;
      if (typeFilter !== 'all' && (l.property_type || 'apartment') !== typeFilter) return false;
      if (contactedFilter === 'contacted' && !l.contacted) return false;
      if (contactedFilter === 'not-contacted' && l.contacted) return false;
      return true;
    });
  }, [listings, search, dealFilter, typeFilter, badgeFilter, contactedFilter]);

  const filtersActive =
    search || dealFilter !== 'all' || typeFilter !== 'all' || badgeFilter !== 'all' || contactedFilter !== 'all';

  const stats = useMemo(() => {
    const total = listings.length;
    const owners = listings.filter((l) => l.label_kind === 'owner').length;
    const notContacted = listings.filter((l) => !l.contacted).length;
    const today = listings.filter((l) => {
      const d = new Date(l.created_at);
      const now = new Date();
      return d.toDateString() === now.toDateString();
    }).length;
    return { total, owners, notContacted, today };
  }, [listings]);

  // ---- Экраны в зависимости от состояния авторизации ----

  if (session === undefined) {
    return <div className="auth-screen"><p className="auth-hint">Загрузка…</p></div>;
  }
  if (!session) {
    return <LoginScreen />;
  }
  if (authorized === false) {
    return <NotAuthorizedScreen email={session.user.email} onSignOut={() => supabase.auth.signOut()} />;
  }

  return (
    <>
      <header>
        <div className="header-top">
          <div>
            <div className="eyebrow">Ташкент · недвижимость</div>
            <h1>Лента новых объявлений</h1>
            <p className="subtitle">Аренда и продажа · OLX.uz + Uybor.uz</p>
          </div>
          <div className="header-actions">
            <button className="btn" onClick={() => setShowTeam(true)}>👥 Команда</button>
            <button className="btn" onClick={() => supabase.auth.signOut()}>Выйти</button>
          </div>
        </div>
        <div className="status-bar">
          <span className="dot" />
          <span>{statusText} · {session.user.email}</span>
        </div>
      </header>

      {showTeam && (
        <TeamPanel authFetch={authFetch} myEmail={session.user.email} onClose={() => setShowTeam(false)} />
      )}

      <main>
        <div className="stats">
          <div className="stat"><div className="num">{stats.total}</div><div className="label">Всего в базе</div></div>
          <div className="stat"><div className="num">{stats.today}</div><div className="label">Сегодня</div></div>
          <div className="stat"><div className="num">{stats.owners}</div><div className="label">Собственники</div></div>
          <div className="stat"><div className="num">{stats.notContacted}</div><div className="label">Ещё не связались</div></div>
        </div>

        <div className="toolbar">
          <input
            type="text"
            placeholder="Поиск по тексту, району…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select value={dealFilter} onChange={(e) => setDealFilter(e.target.value)}>
            <option value="all">Аренда и продажа</option>
            <option value="rent">Только аренда</option>
            <option value="sale">Только продажа</option>
          </select>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">Все типы</option>
            <option value="apartment">Квартиры</option>
            <option value="house">Дома</option>
            <option value="commercial">Коммерция</option>
          </select>
          <select value={badgeFilter} onChange={(e) => setBadgeFilter(e.target.value)}>
            <option value="all">Все объявления</option>
            <option value="owner">Только собственники</option>
            <option value="unsure">Сомнительные</option>
          </select>
          <select value={daysRange} onChange={(e) => setDaysRange(e.target.value)}>
            <option value="3">За 3 дня</option>
            <option value="7">За неделю</option>
            <option value="all">Вся история</option>
          </select>
          <select value={contactedFilter} onChange={(e) => setContactedFilter(e.target.value)}>
            <option value="all">Все (связались/нет)</option>
            <option value="not-contacted">Ещё не связались</option>
            <option value="contacted">Уже связались</option>
          </select>
          {filtersActive && (
            <button className="btn" onClick={resetFilters}>Сбросить фильтры</button>
          )}
          <button className="btn btn-danger" onClick={clearAll}>Очистить базу</button>
        </div>

        <p className="results-count">Показано: {filtered.length} из {listings.length}</p>

        <div className="feed">
          {filtered.length === 0 ? (
            <div className="empty">
              <div className="big">Пока пусто</div>
              {listings.length === 0
                ? 'Объявления появятся здесь, как только сервер найдёт новые'
                : 'Ничего не подходит под текущие фильтры'}
            </div>
          ) : (
            filtered.map((l) => (
              <Card key={l.id} listing={l} onToggleContacted={toggleContacted} />
            ))
          )}
        </div>
      </main>
    </>
  );
}
