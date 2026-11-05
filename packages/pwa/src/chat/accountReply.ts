import type { Session } from '@nanachi/shared';

/**
 * The session after `PUT /api/sessions/:id/account` answered. The reply is a snapshot taken when the daemon finished
 * the switch; the WebSocket has been reporting the session's status the whole time (the agent stopping and resuming
 * on the new account), and its last `session` message can be newer than this HTTP reply. So the account and every
 * other field come from the reply, and the status stays what the live connection says.
 */
export function applyAccountReply(current: Session, reply: Session): Session {
  return { ...reply, status: current.status };
}
