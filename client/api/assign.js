import { supabase } from './_supabase.js';
import { requireAuth } from './_auth.js';

// Зеркало логики кнопки "👤 Беру в работу" из Telegram-бота
// (telegram-webhook.js, handleAssignCallback), но для сайта: тот, кто
// уже взял объявление, — единственный, кто может его освободить.
// Идентификатор человека тут — email (в Telegram это было имя/username
// из Telegram), так что если один и тот же человек берёт объявления и
// с сайта, и из бота, в поле assigned_to могут появляться два разных
// значения для одного человека — это ожидаемо, отдельных аккаунтов
// никто не сводит.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const email = await requireAuth(req, res);
  if (!email) return;

  const { id } = req.body || {};
  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return;
  }

  const { data: current, error: fetchError } = await supabase
    .from('listings')
    .select('assigned_to')
    .eq('id', id)
    .maybeSingle();

  if (fetchError) {
    res.status(500).json({ error: fetchError.message });
    return;
  }
  if (!current) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (current.assigned_to && current.assigned_to !== email) {
    res.status(409).json({ error: `Уже взял в работу: ${current.assigned_to}`, assigned_to: current.assigned_to });
    return;
  }

  const next = current.assigned_to ? null : email; // повторный клик — освобождает

  const { data, error } = await supabase
    .from('listings')
    .update({ assigned_to: next, assigned_at: next ? new Date().toISOString() : null })
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(200).json(data);
}
