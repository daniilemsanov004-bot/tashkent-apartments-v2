import { supabase } from './_supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  // Подтверждённые агентства (label_kind = 'agent') не показываем вовсе —
  // ни на сайте, ни (отдельно, в scraper) в Telegram. Они остаются в базе
  // только для дедупликации, чтобы не обрабатывать их заново. Если
  // когда-нибудь понадобится посмотреть, что было отфильтровано —
  // добавить ?showAgents=true к запросу.
  let query = supabase.from('listings').select('*').order('created_at', { ascending: false });

  if (req.query.showAgents !== 'true') {
    query = query.neq('label_kind', 'agent');
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(200).json(data);
}
