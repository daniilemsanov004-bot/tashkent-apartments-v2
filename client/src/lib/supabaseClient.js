import { createClient } from '@supabase/supabase-js';

// ВАЖНО: здесь используется ПУБЛИЧНЫЙ (anon) ключ — он специально
// предназначен для браузера и не даёт прямого доступа к данным сам
// по себе (у нас нет открытых RLS-политик на listings). Настоящая
// проверка прав происходит на сервере в /api/_auth.js.
// Не путать с SUPABASE_SERVICE_KEY — тот секретный, используется
// только в scraper/ и в client/api/ (на сервере), никогда в браузере.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
