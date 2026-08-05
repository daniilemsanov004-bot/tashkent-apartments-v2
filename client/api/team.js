import { supabase } from './_supabase.js';
import { requireAuth } from './_auth.js';

export default async function handler(req, res) {
  const email = await requireAuth(req, res);
  if (!email) return;

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('team_members')
      .select('email, added_by, created_at')
      .order('created_at', { ascending: true });
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(200).json(data);
    return;
  }

  if (req.method === 'POST') {
    const newEmail = (req.body?.email || '').trim().toLowerCase();
    if (!newEmail || !newEmail.includes('@')) {
      res.status(400).json({ error: 'valid email is required' });
      return;
    }
    const { data, error } = await supabase
      .from('team_members')
      .insert({ email: newEmail, added_by: email })
      .select()
      .maybeSingle();
    if (error) {
      // Уже существует — не считаем это ошибкой
      if (error.code === '23505') {
        res.status(200).json({ email: newEmail, already_existed: true });
        return;
      }
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(200).json(data);
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}
