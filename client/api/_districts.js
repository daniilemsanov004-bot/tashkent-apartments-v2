// Копия scraper/src/districts.js — используется тут для генерации
// кнопок районов и slug<->название в telegram-webhook.js.
// ВАЖНО: client/ и scraper/ — разные deployable-проекты (Vercel и
// GitHub Actions соответственно), общего import-пути между ними нет,
// поэтому список районов продублирован. Меняете список районов —
// поправьте ОБА файла (тут и в scraper/src/districts.js) одинаково.

export const DISTRICTS = [
  { canonical: 'Мирзо-Улугбекский', aliases: ['мирзо-улугбек', 'мирзо улугбек', 'мирзоулугбек', 'улугбекский', 'улугбек', 'mirzo-ulugbek', 'mirzo ulugbek'] },
  { canonical: 'Юнусабадский', aliases: ['юнусабад', 'юнусобод', 'yunusabad', 'yunusobod'] },
  { canonical: 'Яккасарайский', aliases: ['яккасарай', 'яккасарой', 'yakkasaray', 'yakkasaroy'] },
  { canonical: 'Яшнабадский', aliases: ['яшнабад', 'яшнобод', 'yashnabad', 'yashnobod'] },
  { canonical: 'Мирабадский', aliases: ['мирабад', 'миробод', 'mirabad', 'mirobod'] },
  { canonical: 'Сергелийский', aliases: ['сергели', 'sergeli'] },
  { canonical: 'Шайхантахурский', aliases: ['шайхантахур', 'shayxontohur', 'shaykhantakhur'] },
  { canonical: 'Чиланзарский', aliases: ['чиланзар', 'chilonzor', 'chilanzar'] },
  { canonical: 'Алмазарский', aliases: ['алмазар', 'олмазор', 'almazar', 'olmazor'] },
  { canonical: 'Бектемирский', aliases: ['бектемир', 'bektemir'] },
  { canonical: 'Учтепинский', aliases: ['учтепа', 'uchtepa'] },
  { canonical: 'Янгихаётский', aliases: ['янгихаёт', 'янгихает', 'yangihayot', 'yangi hayot'] },
  { canonical: 'Янгиташкентский', aliases: ['янгиташкент', 'yangi tashkent', 'yangitashkent'] },
];

const SLUG_BY_CANONICAL = new Map(DISTRICTS.map((d, i) => [d.canonical, `d${i}`]));
const CANONICAL_BY_SLUG = new Map(DISTRICTS.map((d, i) => [`d${i}`, d.canonical]));

export function districtSlug(canonical) {
  return SLUG_BY_CANONICAL.get(canonical) || null;
}

export function districtFromSlug(slug) {
  return CANONICAL_BY_SLUG.get(slug) || null;
}
