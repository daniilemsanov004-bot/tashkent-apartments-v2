import { useEffect, useMemo, useState, useCallback } from 'react';

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
  if (listing.label_kind === 'unchecked') return { cls: 'badge-unchecked', text: 'Без проверки ИИ' };
  if (listing.label_kind === 'agent') return { cls: 'badge-agent', text: `🏢 ${listing.label_text || 'Агентство'}` };
  return { cls: 'badge-unsure', text: '? Сомнительно' };
}

function dealTag(dealType) {
  if (dealType === 'sale') return <span className="deal-tag deal-sale">Продажа</span>;
  if (dealType === 'rent') return <span className="deal-tag deal-rent">Аренда</span>;
  return null;
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
            <span className="source-tag">{listing.source}</span>
            &nbsp;·&nbsp;{timeAgo(listing.created_at)}
            {listing.district ? ` · 📍 ${listing.district}` : ''}
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

export default function App() {
  const [listings, setListings] = useState([]);
  const [statusText, setStatusText] = useState('Загрузка…');
  const [search, setSearch] = useState('');
  const [dealFilter, setDealFilter] = useState('all');
  const [badgeFilter, setBadgeFilter] = useState('all');
  const [contactedFilter, setContactedFilter] = useState('all');

  const fetchListings = useCallback(async () => {
    try {
      const res = await fetch('/api/listings');
      const data = await res.json();
      setListings(data);
      setStatusText('Обновлено ' + new Date().toLocaleTimeString('ru-RU'));
    } catch (err) {
      setStatusText('Не удалось связаться с сервером');
    }
  }, []);

  useEffect(() => {
    fetchListings();
    const id = setInterval(fetchListings, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchListings]);

  const toggleContacted = useCallback(async (id, next) => {
    // оптимистичное обновление — сразу видно в интерфейсе
    setListings((prev) => prev.map((l) => (l.id === id ? { ...l, contacted: next } : l)));
    try {
      await fetch(`/api/contacted`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, contacted: next }),
      });
    } catch (err) {
      console.error('Не удалось обновить статус:', err);
    }
  }, []);

  const clearAll = useCallback(async () => {
    const confirmed = window.confirm(
      'Удалить все объявления из базы? Это нельзя отменить. При следующей проверке сегодняшние объявления придут заново.'
    );
    if (!confirmed) return;
    try {
      await fetch('/api/clear', { method: 'POST' });
      setListings([]);
    } catch (err) {
      console.error('Не удалось очистить базу:', err);
    }
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return listings.filter((l) => {
      if (q) {
        const haystack = `${l.title} ${l.district || ''} ${l.raw_text || ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (badgeFilter === 'owner' && l.label_kind !== 'owner') return false;
      if (badgeFilter === 'unsure' && l.label_kind !== 'unsure') return false;
      if (dealFilter !== 'all' && l.deal_type !== dealFilter) return false;
      if (contactedFilter === 'contacted' && !l.contacted) return false;
      if (contactedFilter === 'not-contacted' && l.contacted) return false;
      return true;
    });
  }, [listings, search, dealFilter, badgeFilter, contactedFilter]);

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

  return (
    <>
      <header>
        <div className="eyebrow">Ташкент · недвижимость</div>
        <h1>Лента новых объявлений</h1>
        <p className="subtitle">Аренда и продажа · OLX.uz + Uybor.uz</p>
        <div className="status-bar">
          <span className="dot" />
          <span>{statusText}</span>
        </div>
      </header>

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
          <select value={badgeFilter} onChange={(e) => setBadgeFilter(e.target.value)}>
            <option value="all">Все объявления</option>
            <option value="owner">Только собственники</option>
            <option value="unsure">Сомнительные</option>
          </select>
          <select value={contactedFilter} onChange={(e) => setContactedFilter(e.target.value)}>
            <option value="all">Все (связались/нет)</option>
            <option value="not-contacted">Ещё не связались</option>
            <option value="contacted">Уже связались</option>
          </select>
          <button className="btn btn-danger" onClick={clearAll}>Очистить базу</button>
        </div>

        <div className="feed">
          {filtered.length === 0 ? (
            <div className="empty">
              <div className="big">Пока пусто</div>
              Объявления появятся здесь, как только сервер найдёт новые
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
