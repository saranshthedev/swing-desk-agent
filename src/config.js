// Where data lives. The default is outside the repository and outside synced folders
// (OneDrive/Dropbox can corrupt a live SQLite file). Backups go wherever you choose.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function dataDir() {
  if (process.env.SWING_DESK_DATA) return resolve(process.env.SWING_DESK_DATA);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'SwingDeskAgent');
  return join(homedir(), '.swing-desk-agent');
}

export const dbFile = () => join(dataDir(), 'desk.sqlite');
export const backupDir = () => resolve(process.env.SWING_DESK_BACKUPS || join(dataDir(), 'backups'));
export const port = () => Number(process.env.SWING_DESK_PORT || 8790);
