import { supabase } from './_supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  // Удаляем все строки — id никогда не бывает пустой строкой,
  // поэтому neq('id', '') матчит вообще всё.
  const { error } = await supabase.from('listings').delete().neq('id', '');

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(200).json({ ok: true });
}
