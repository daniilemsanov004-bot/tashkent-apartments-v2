import { supabase } from './_supabase.js';

/**
 * Проверяет заголовок Authorization: Bearer <токен>, который фронтенд
 * присылает после входа через Supabase Auth (magic link). Возвращает
 * email пользователя, если токен валиден И email есть в team_members.
 * Иначе — null (значит, доступ запрещён).
 */
export async function getAuthorizedEmail(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user?.email) return null;

  const email = userData.user.email.toLowerCase();

  const { data: member, error: memberError } = await supabase
    .from('team_members')
    .select('email')
    .eq('email', email)
    .maybeSingle();

  if (memberError || !member) return null;

  return email;
}

/**
 * Общая обёртка: если не авторизован — сразу отвечает 401 и возвращает
 * null; иначе возвращает email и позволяет функции продолжить работу.
 */
export async function requireAuth(req, res) {
  const email = await getAuthorizedEmail(req);
  if (!email) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  return email;
}
