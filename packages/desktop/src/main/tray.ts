import { Menu, nativeImage, Tray } from 'electron';
import { buildTrayMenu, trayTooltip, type TrayActions, type TrayMenuInput } from './tray-menu.js';

export interface TrayController {
  /** Rebuilds the tooltip and the menu for a new status or autostart state. */
  update(input: Omit<TrayMenuInput, 'actions'>): void;
  destroy(): void;
}

/** Tray icon from the user's own PNG (`icon-192.png`), scaled for the notification area. Never regenerated or edited. */
export function createTray(iconPath: string, actions: TrayActions, initial: Omit<TrayMenuInput, 'actions'>): TrayController {
  const image = nativeImage.createFromPath(iconPath).resize({ width: 32, height: 32, quality: 'best' });
  const tray = new Tray(image);
  tray.on('click', () => actions.openPanel());

  function update(input: Omit<TrayMenuInput, 'actions'>): void {
    tray.setToolTip(trayTooltip(input.status));
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu({ ...input, actions })));
  }
  update(initial);

  return {
    update,
    destroy: () => tray.destroy(),
  };
}
