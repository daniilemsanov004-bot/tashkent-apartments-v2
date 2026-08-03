import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service_role ключ — обходит RLS, только для бэкенда, никогда не светить на фронтенде
);

export async function isKnown(id) {
  const { data, error } = await supabase.from('listings').select('id').eq('id', id).maybeSingle();
  if (error) {
    console.error('Supabase (isKnown) ошибка:', error.message);
    return false; // при сбое лучше перепроверить объявление ещё раз, чем потерять его
  }
  return !!data;
}

export async function saveListing(listing) {
  const { error } = await supabase
    .from('listings')
    .upsert({ ...listing, contacted: false }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) {
    console.error('Supabase (saveListing) ошибка:', error.message);
  }
}

export async function markNotified(id) {
  const { error } = await supabase.from('listings').update({ notified: true }).eq('id', id);
  if (error) {
    console.error('Supabase (markNotified) ошибка:', error.message);
  }
}
