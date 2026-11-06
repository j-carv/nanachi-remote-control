import { Trash } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { setLanguage } from './i18n/index.js';
import { machineMenuRows } from './machineMenuRows.js';

describe('machineMenuRows', () => {
  it('offers "Remover máquina" as the destructive row, and removes the machine when picked', () => {
    const onRemove = vi.fn();
    const [row] = machineMenuRows(onRemove);

    expect(row).toMatchObject({ label: 'Remover máquina', icon: Trash, tone: 'danger' });
    row?.onSelect();
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('names the row in English and in Spanish', () => {
    setLanguage('en');
    expect(machineMenuRows(() => undefined)).toMatchObject([{ label: 'Remove machine', tone: 'danger' }]);
    setLanguage('es');
    expect(machineMenuRows(() => undefined)).toMatchObject([{ label: 'Quitar máquina', tone: 'danger' }]);
  });
});
