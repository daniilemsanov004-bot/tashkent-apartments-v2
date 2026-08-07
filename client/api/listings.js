import { supabase } from './_supabase.js';
import { requireAuth } from './_auth.js';
import { sortByPriority } from './_priority.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const email = await requireAuth(req, res);
  if (!email) return; // requireAuth уже отправил 401

  // По умолчанию показываем только последние N дней (3) — иначе база
  // со временем упрётся в лимит Supabase на 1000 строк за запрос, да
  // и сама лента станет неюзабельной от старья. Можно расширить через
  // ?days=7, или ?days=all для полной истории.
  const daysParam = req.query.days;
  const days = daysParam === 'all' ? null : Number(daysParam) || 3;

  let query = supabase
    .from('listings')
    .select('*')
    .order('created_at', { ascending: false })
    .range(0, 4999); // явно просим больше дефолтного лимита в 1000

  if (days !== null) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte('created_at', cutoff);
  }

  // Агентства (подтверждённые жёсткими правилами — много объявлений
  // у продавца / аккаунт-организация) снова скрываем полностью — и с
  // сайта, и (см. scraper/run.js) из Telegram. Раньше пробовали
  // показывать всех с приоритетом собственников сверху, но по
  // ощущениям агентских объявлений становится слишком много и они
  // мешают — вернули как было. ?showAgents=true — для отладки.
  if (req.query.showAgents !== 'true') {
    query = query.neq('label_kind', 'agent').neq('flagged_agent', true);
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(200).json(sortByPriority(data));
}
