/**
 * A value that is kept current by events and also read now and then by a poll (the daemon and Tailscale status: main
 * pushes every change, and the overview asks for everything every few seconds). A poll answers what was true when main
 * read it; when an event arrived while the call was in flight, the event is newer and the poll must not overwrite it. The
 * same goes for a poll that was overtaken by a newer poll.
 */
export interface PollToken {
  readonly events: number;
  readonly poll: number;
}

export interface LiveValue<T> {
  /** The latest value: null until the first event or the first poll answer. */
  value(): T | null;
  /** An event: the value, and the newest news there is. */
  event(next: T): void;
  /** Call right before a poll starts; pass the token to `offer` with its answer. */
  begin(): PollToken;
  /**
   * The answer of the poll that took `token`. Applied (true) unless an event arrived since `begin`, or a newer poll has
   * started since. The very first value is always taken.
   */
  offer(token: PollToken, next: T): boolean;
}

export function createLiveValue<T>(): LiveValue<T> {
  let current: T | null = null;
  let events = 0;
  let polls = 0;
  return {
    value: () => current,
    event(next) {
      events += 1;
      current = next;
    },
    begin() {
      polls += 1;
      return { events, poll: polls };
    },
    offer(token, next) {
      if (current !== null && (token.events !== events || token.poll !== polls)) return false;
      current = next;
      return true;
    },
  };
}
