import { createClient } from '@supabase/supabase-js';

// Эти переменные задаются в Vercel: Project Settings → Environment
// Variables. SUPABASE_SERVICE_KEY — это service_role ключ, он работает
// только на сервере (внутри serverless-функции), в браузер не попадает.
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
