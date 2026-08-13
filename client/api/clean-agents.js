import { requireOwner } from './_auth.js';
import { cleanAgentMessagesBatch } from './_cleanAgents.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  // Массовое удаление сообщений в Telegram — тоже только владелец.
  const email = await requireOwner(req, res);
  if (!email) return;

  try {
    const result = await cleanAgentMessagesBatch(25);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
