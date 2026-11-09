import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { LiveConnections, type LiveSocket } from '../src/live-connections.js';

function openSocket(): LiveSocket {
  return { readyState: WebSocket.OPEN, close: () => undefined };
}

describe('LiveConnections: subscribed sessions', () => {
  it('a socket subscribed to session A makes its device follow A, not B', () => {
    const connections = new LiveConnections<LiveSocket>();
    const socket = openSocket();
    connections.add('d1', socket);
    connections.subscribe(socket, 'A');

    expect(connections.hasLiveSubscription('d1', 'A')).toBe(true);
    expect(connections.hasLiveSubscription('d1', 'B')).toBe(false);
  });

  it('an open socket with no subscription (another screen) follows no session', () => {
    const connections = new LiveConnections<LiveSocket>();
    connections.add('d1', openSocket());

    expect(connections.hasLiveSubscription('d1', 'A')).toBe(false);
  });

  it('unsubscribe re-enables the push; subscribing again suppresses it', () => {
    const connections = new LiveConnections<LiveSocket>();
    const socket = openSocket();
    connections.add('d1', socket);
    connections.subscribe(socket, 'A');

    connections.unsubscribe(socket, 'A');
    expect(connections.hasLiveSubscription('d1', 'A')).toBe(false);

    connections.subscribe(socket, 'A');
    expect(connections.hasLiveSubscription('d1', 'A')).toBe(true);
  });

  it('subscribing twice to the same session counts once: one unsubscribe is enough', () => {
    const connections = new LiveConnections<LiveSocket>();
    const socket = openSocket();
    connections.add('d1', socket);
    connections.subscribe(socket, 'A');
    connections.subscribe(socket, 'A');

    connections.unsubscribe(socket, 'A');

    expect(connections.hasLiveSubscription('d1', 'A')).toBe(false);
  });

  it('a socket with several sessions follows all of them; each unsubscribe releases only its own', () => {
    const connections = new LiveConnections<LiveSocket>();
    const socket = openSocket();
    connections.add('d1', socket);
    connections.subscribe(socket, 'A');
    connections.subscribe(socket, 'B');

    connections.unsubscribe(socket, 'A');

    expect(connections.hasLiveSubscription('d1', 'A')).toBe(false);
    expect(connections.hasLiveSubscription('d1', 'B')).toBe(true);
  });

  it('closing the socket releases its subscriptions', () => {
    const connections = new LiveConnections<LiveSocket>();
    const socket = openSocket();
    connections.add('d1', socket);
    connections.subscribe(socket, 'A');

    connections.remove('d1', socket);

    expect(connections.hasLiveSubscription('d1', 'A')).toBe(false);
  });

  it('a socket that is closing (no longer OPEN) does not count, even while subscribed', () => {
    const connections = new LiveConnections<LiveSocket>();
    const socket: LiveSocket = { readyState: WebSocket.CLOSING, close: () => undefined };
    connections.add('d1', socket);
    connections.subscribe(socket, 'A');

    expect(connections.hasLiveSubscription('d1', 'A')).toBe(false);
  });

  it('with several sockets per device, the subscribed one counts; closing one leaves the other', () => {
    const connections = new LiveConnections<LiveSocket>();
    const phone = openSocket();
    const tablet = openSocket();
    connections.add('d1', phone);
    connections.add('d1', tablet);
    connections.subscribe(phone, 'A');
    connections.subscribe(tablet, 'B');

    expect(connections.hasLiveSubscription('d1', 'A')).toBe(true);
    expect(connections.hasLiveSubscription('d1', 'B')).toBe(true);

    connections.remove('d1', phone);

    expect(connections.hasLiveSubscription('d1', 'A')).toBe(false);
    expect(connections.hasLiveSubscription('d1', 'B')).toBe(true);
  });

  it('a subscription belongs to its socket: another device on the same session is not affected', () => {
    const connections = new LiveConnections<LiveSocket>();
    const socket = openSocket();
    connections.add('d1', socket);
    connections.add('d2', openSocket());
    connections.subscribe(socket, 'A');

    expect(connections.hasLiveSubscription('d2', 'A')).toBe(false);
  });

  it('a device with no socket follows no session', () => {
    expect(new LiveConnections<LiveSocket>().hasLiveSubscription('nobody', 'A')).toBe(false);
  });
});
