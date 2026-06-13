import dotenv from 'dotenv';

// The dev server reads its configuration from `.env.local` (copied from `.env.example`).
// `dotenv/config` only loads `.env`, which this example does not ship, so load `.env.local`
// explicitly and fall back to `.env`. dotenv does not override already-set variables, so the
// first file wins and real environment variables still take precedence over both.
dotenv.config({ path: '.env.local' });
dotenv.config();
