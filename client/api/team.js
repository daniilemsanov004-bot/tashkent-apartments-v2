import { supabase } from './_supabase.js';
import { requireAuth, requireOwner } from './_auth.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // Список видят все члены команды (владелец и админы) — управлять
    // (приглашать/менять роль/удалять) может только владелец, это
    // проверяется в POST/PATCH/DELETE ниже.
    const email = await requireAuth(req, res);
    if (!email) return;

    const { data, error } = await supabase
      .from('team_members')
      .select('email, role, added_by, created_at')
      .order('created_at', { ascending: true });
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(200).json(data);
    return;
  }

  if (req.method === 'POST') {
    const ownerEmail = await requireOwner(req, res);
    if (!ownerEmail) return; // requireOwner уже отправил 401/403

    const newEmail = (req.body?.email || '').trim().toLowerCase();
    const role = req.body?.role === 'owner' ? 'owner' : 'admin';
    if (!newEmail || !newEmail.includes('@')) {
      res.status(400).json({ error: 'valid email is required' });
      return;
    }
    const { data, error } = await supabase
      .from('team_members')
      .insert({ email: newEmail, added_by: ownerEmail, role })
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

  if (req.method === 'PATCH') {
    // Смена роли участника — только владелец.
    const ownerEmail = await requireOwner(req, res);
    if (!ownerEmail) return;

    const targetEmail = (req.body?.email || '').trim().toLowerCase();
    const newRole = req.body?.role;
    if (!targetEmail || (newRole !== 'owner' && newRole !== 'admin')) {
      res.status(400).json({ error: 'email and valid role are required' });
      return;
    }

    // Нельзя разжаловать самого себя, если ты последний владелец —
    // иначе управлять командой станет некому.
    if (targetEmail === ownerEmail && newRole !== 'owner') {
      const { count, error: countError } = await supabase
        .from('team_members')
        .select('email', { count: 'exact', head: true })
        .eq('role', 'owner');
      if (countError) {
        res.status(500).json({ error: countError.message });
        return;
      }
      if ((count || 0) <= 1) {
        res.status(400).json({ error: 'cannot remove the last owner\u2019s role' });
        return;
      }
    }

    const { data, error } = await supabase
      .from('team_members')
      .update({ role: newRole })
      .eq('email', targetEmail)
      .select()
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    if (!data) {
      res.status(404).json({ error: 'member not found' });
      return;
    }
    res.status(200).json(data);
    return;
  }

  if (req.method === 'DELETE') {
    // Удаление из команды — только владелец.
    const ownerEmail = await requireOwner(req, res);
    if (!ownerEmail) return;

    const targetEmail = (req.body?.email || req.query?.email || '').trim().toLowerCase();
    if (!targetEmail) {
      res.status(400).json({ error: 'email is required' });
      return;
    }

    if (targetEmail === ownerEmail) {
      const { count, error: countError } = await supabase
        .from('team_members')
        .select('email', { count: 'exact', head: true })
        .eq('role', 'owner');
      if (countError) {
        res.status(500).json({ error: countError.message });
        return;
      }
      if ((count || 0) <= 1) {
        res.status(400).json({ error: 'cannot remove the last owner' });
        return;
      }
    }

    const { error } = await supabase.from('team_members').delete().eq('email', targetEmail);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.status(200).json({ email: targetEmail, deleted: true });
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
}
