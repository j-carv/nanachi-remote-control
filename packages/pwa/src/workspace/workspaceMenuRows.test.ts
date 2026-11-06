import { describe, expect, it, vi } from 'vitest';
import { Bell, BellOff } from 'lucide-react';
import { setLanguage } from '../i18n/index.js';
import { notificationsRow } from './workspaceMenuRows.js';

describe('notificationsRow', () => {
  it('shows notifications as on, with the bell, and mutes them when picked', () => {
    const onToggle = vi.fn();
    const row = notificationsRow(false, onToggle);

    expect(row.label).toBe('Notificações');
    expect(row.detail).toBe('Ligadas');
    expect(row.icon).toBe(Bell);
    expect(row.tone).toBeUndefined();
    row.onSelect();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('shows notifications as muted, with the crossed bell, and unmutes them when picked', () => {
    const onToggle = vi.fn();
    const row = notificationsRow(true, onToggle);

    expect(row.detail).toBe('Silenciadas');
    expect(row.icon).toBe(BellOff);
    row.onSelect();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('keeps the focus on the sheet trigger when picked: the user stays on the same screen', () => {
    expect(notificationsRow(false, () => undefined).keepsFocus).toBe(true);
    expect(notificationsRow(true, () => undefined).keepsFocus).toBe(true);
  });

  it('names the row and its state in English', () => {
    setLanguage('en');
    expect(notificationsRow(false, () => undefined)).toMatchObject({ label: 'Notifications', detail: 'On' });
    expect(notificationsRow(true, () => undefined)).toMatchObject({ label: 'Notifications', detail: 'Muted' });
  });

  it('names the row and its state in Spanish, with the same words as the Portuguese ones', () => {
    setLanguage('es');
    expect(notificationsRow(false, () => undefined)).toMatchObject({ label: 'Notificaciones', detail: 'Activadas' });
    expect(notificationsRow(true, () => undefined)).toMatchObject({ label: 'Notificaciones', detail: 'Silenciadas' });
  });
});
