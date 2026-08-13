// Нормализация названий районов Ташкента.
//
// Проблема: с разных сайтов район приходит по-разному — кириллица/
// латиница, с "район"/"туман" на конце или без, иногда с опечатками
// или альтернативным написанием (Юнусабад/Юнусобод). Без нормализации
// фильтр по району в Telegram-боте не будет находить объявления,
// написанные не в точности так же, как выбрана кнопка.
//
// ВАЖНО: этот файл — источник истины для scraper/. В client/api/ есть
// его копия (_districts.js), т.к. scraper/ и client/ — два отдельных
// deployable-проекта (разные package.json/node_modules, разный
// хостинг — GitHub Actions и Vercel) и не имеют общего import-пути
// между собой. Если меняете список районов или алиасы — правьте ОБА
// файла одинаково.
//
// Список из 13 позиций: 11 классических городских районов Ташкента +
// 2 новых (Янгихаётский и Янгиташкентский), которые встречались как
// отдельные пункты в фильтре Realting.uz. Список НЕ подтверждён
// пользователем как окончательный — если в реальных объявлениях
// массово попадается район, которого тут нет, стоит его добавить.

export const DISTRICTS = [
  {
    canonical: 'Мирзо-Улугбекский',
    aliases: ['мирзо-улугбек', 'мирзо улугбек', 'мирзоулугбек', 'улугбекский', 'улугбек', 'mirzo-ulugbek', 'mirzo ulugbek', 'mirzo-ulugbekskiy'],
  },
  {
    canonical: 'Юнусабадский',
    aliases: ['юнусабад', 'юнусобод', 'yunusabad', 'yunusobod'],
  },
  {
    canonical: 'Яккасарайский',
    aliases: ['яккасарай', 'яккасарой', 'yakkasaray', 'yakkasaroy'],
  },
  {
    canonical: 'Яшнабадский',
    aliases: ['яшнабад', 'яшнобод', 'yashnabad', 'yashnobod'],
  },
  {
    canonical: 'Мирабадский',
    aliases: ['мирабад', 'миробод', 'mirabad', 'mirobod'],
  },
  {
    canonical: 'Сергелийский',
    aliases: ['сергели', 'sergeli'],
  },
  {
    canonical: 'Шайхантахурский',
    aliases: ['шайхантахур', 'шайхантахурский', 'shayxontohur', 'shayxontoxur', 'shaykhantakhur', 'shaykhantahur', 'shaykhontokhur'],
  },
  {
    canonical: 'Чиланзарский',
    aliases: ['чиланзар', 'chilonzor', 'chilanzar', 'chilanzor'],
  },
  {
    canonical: 'Алмазарский',
    aliases: ['алмазар', 'олмазор', 'almazar', 'olmazor'],
  },
  {
    canonical: 'Бектемирский',
    aliases: ['бектемир', 'bektemir'],
  },
  {
    canonical: 'Учтепинский',
    aliases: ['учтепа', 'учтепинский', 'uchtepa'],
  },
  {
    canonical: 'Янгихаётский',
    aliases: ['янгихаёт', 'янгихает', 'yangihayot', 'yangi hayot', 'yangi-hayot'],
  },
  {
    canonical: 'Янгиташкентский',
    aliases: ['янгиташкент', 'yangi tashkent', 'yangitashkent', 'yangi-tashkent'],
  },
];

// slug для callback_data в Telegram-кнопках (латиница, без пробелов —
// у callback_data есть ограничение по символам/длине).
const SLUG_BY_CANONICAL = new Map(
  DISTRICTS.map((d, i) => [d.canonical, `d${i}`])
);
const CANONICAL_BY_SLUG = new Map(
  DISTRICTS.map((d, i) => [`d${i}`, d.canonical])
);

export function districtSlug(canonical) {
  return SLUG_BY_CANONICAL.get(canonical) || null;
}

export function districtFromSlug(slug) {
  return CANONICAL_BY_SLUG.get(slug) || null;
}

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    // Апостроф в узбекской латинице (тутук-белгиси, "Ulug'bek",
    // "Yunusobod" вариантами) на разных сайтах приходит РАЗНЫМИ
    // юникод-символами — прямой апостроф ', левая/правая типографская
    // кавычка '‘'/'’', модификатор-буква 'ʻ'/'ʼ'. Раньше вырезался
    // только прямой апостроф (см. [«»"'.,] ниже) — из-за этого,
    // например, "Mirzo Ulug‘bek tumani" от Joymee (там кавычка U+2018)
    // не совпадал с алиасом "mirzo ulugbek" в districts.js, и весь
    // Мирзо-Улугбекский район молча терялся, если сайт отдал район
    // только через текстовую строку адреса, а не структурным полем.
    // Обнаружено 12.08.2026. Убираем ВСЕ варианты одним regex'ом.
    .replace(/['‘’ʻʼ`]/g, '')
    .replace(/[«»".,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Ищет упоминание известного района в произвольном тексте (название
 * от ИИ-классификации, структурное поле с сайта или просто текст
 * объявления — работает как fallback, если структурного поля нет).
 * Возвращает каноничное название или null, если ничего не найдено.
 */
export function normalizeDistrict(text) {
  if (!text) return null;
  const hay = normalize(text);
  if (!hay) return null;

  for (const { canonical, aliases } of DISTRICTS) {
    for (const alias of aliases) {
      const needle = normalize(alias);
      if (needle && hay.includes(needle)) {
        return canonical;
      }
    }
  }
  return null;
}
