import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  realtime: { transport: WebSocket },
});

async function main() {
  const { count: total, error: e1 } = await supabase
    .from('listings')
    .select('*', { count: 'exact', head: true });
  if (e1) throw new Error(e1.message);
  console.log(`Всего записей в listings: ${total}`);

  const { data: oldest } = await supabase
    .from('listings')
    .select('created_at')
    .order('created_at', { ascending: true })
    .limit(1);
  const { data: newest } = await supabase
    .from('listings')
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(1);
  console.log(`Самая старая запись: ${oldest?.[0]?.created_at}`);
  console.log(`Самая новая запись:  ${newest?.[0]?.created_at}`);

  console.log('\nРаспределение по label_kind:');
  for (const kind of ['owner', 'unchecked', 'agent', 'uncertain', null]) {
    let q = supabase.from('listings').select('*', { count: 'exact', head: true });
    q = kind === null ? q.is('label_kind', null) : q.eq('label_kind', kind);
    const { count, error } = await q;
    if (error) {
      console.log(`  ${kind ?? 'NULL'}: ошибка запроса — ${error.message}`);
    } else {
      console.log(`  ${kind ?? 'NULL'}: ${count}`);
    }
  }

  console.log('\nПо дням (created_at, последние 7 дней встреченных):');
  const { data: recent } = await supabase
    .from('listings')
    .select('created_at')
    .order('created_at', { ascending: false })
    .limit(2000);
  const byDay = {};
  for (const row of recent || []) {
    const day = row.created_at?.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }
  for (const [day, cnt] of Object.entries(byDay).sort().reverse()) {
    console.log(`  ${day}: ${cnt}`);
  }
}

main().catch((err) => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
