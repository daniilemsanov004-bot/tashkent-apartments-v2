import { supabase } from './_supabase.js';
import { requireAuth } from './_auth.js';

// Раньше заметку можно было оставить только ответом на сообщение бота
// в Telegram (tryHandleNoteReply в telegram-webhook.js). Теперь то же
// самое поле notes можно редактировать прямо с сайта.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const email = await requireAuth(req, res);
  if (!email) return;

  const { id, notes } = req.body || {};
  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return;
  }

  const { data, error } = await supabase
    .from('listings')
    .update({ notes: (notes || '').slice(0, 500) })
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  if (!data) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  res.status(200).json(data);
}
