import { createClient } from '@supabase/supabase-js';

// ВАЖНО: здесь используется ПУБЛИЧНЫЙ (anon) ключ — он специально
// предназначен для браузера и не даёт прямого доступа к данным сам
// по себе (у нас нет открытых RLS-политик на listings). Настоящая
// проверка прав происходит на сервере в /api/_auth.js.
// Не путать с SUPABASE_SERVICE_KEY — тот секретный, используется
// только в scraper/ и в client/api/ (на сервере), никогда в браузере.
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Раньше при отсутствующих переменных весь сайт падал белым экраном
// с "supabaseUrl is required" прямо в консоли — непонятно, что делать.
// Теперь показываем понятное сообщение прямо на странице.
export const supabaseConfigMissing = !url || !anonKey;

export const supabase = supabaseConfigMissing
  ? null
  : createClient(url, anonKey);
