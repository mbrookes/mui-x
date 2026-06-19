import { Router } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, '../../dashboard-state.json');

let dashboardState: unknown | null = null;

// Hydrate from disk on module load
try {
  dashboardState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  log('[dashboard-state] Loaded saved state from disk');
} catch {
  // First run — file doesn't exist yet
}

export function getDashboardState(): unknown | null {
  return dashboardState;
}

export function setDashboardState(state: unknown): void {
  dashboardState = state;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

export function makeDashboardStateRouter(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    if (!dashboardState) {
      res.status(404).json({ error: 'No saved dashboard state' });
      return;
    }
    res.json(dashboardState);
  });

  router.post('/', (req, res) => {
    setDashboardState(req.body);
    log('[dashboard-state] State saved');
    res.json({ success: true });
  });

  return router;
}
