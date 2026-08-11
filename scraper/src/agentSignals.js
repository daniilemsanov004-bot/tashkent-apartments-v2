// Проверка текста объявления (заголовок + описание) на слова, которые
// частник практически никогда не пишет о себе, а агентство/риелтор —
// сплошь и рядом. В отличие от проверок по OLX/Uybor/Realting, не
// зависит от вёрстки конкретного сайта вообще — работает даже на
// одном заголовке, если полный текст не удалось получить (см.
// комментарий про detailsFetchFailed в run.js).

const AGENT_KEYWORDS_RE =
  /риэлтор|риелтор|realtor|агентств|агенство|real\s*estate|брокер|broker|подбор\s+(?:жилья|квартир|недвижимост)|показ(?:ы)?\s+по\s+записи|в\s+наличии\s+\d+\s+вариант|наша\s+компания|estate\s*agency/i;

// "комиссия" сама по себе — плохой признак: частники САМИ часто пишут
// "без комиссии" именно чтобы отличаться от агентств — это ОБРАТНЫЙ
// сигнал (собственник, а не агент). Поэтому "комисси" считаем
// агентским сигналом только если рядом нет "без".
const COMMISSION_RE = /комисси/i;
const NO_COMMISSION_RE = /без\s+комисси/i;

/**
 * @param {string|null|undefined} text
 * @returns {string|null} найденное слово-сигнал или null, если ничего не нашли
 */
export function findAgentTextSignal(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  const m = t.match(AGENT_KEYWORDS_RE);
  if (m) return m[0];
  if (COMMISSION_RE.test(t) && !NO_COMMISSION_RE.test(t)) return 'комиссия';
  return null;
}
