import 'dotenv/config';

export interface Config {
  port: number;
  db: DbConfig;
  crmDb: DbConfig;
  seedOrderCount: number;
  llm: LlmConfig;
  jwtSecret: string;
  studioToken: string | undefined;
  allowedOrigins: string[];
}

export interface DbConfig {
  client: string;
  // SQLite
  filename?: string;
  // Postgres / MySQL
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export interface LlmConfig {
  endpoint: string;
  apiKey: string | undefined;
  model: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}

function buildDbConfig(): DbConfig {
  const client = process.env.DB_CLIENT ?? 'better-sqlite3';

  if (client === 'better-sqlite3') {
    return {
      client,
      filename: process.env.DB_FILENAME ?? './sales.db',
    };
  }

  // Postgres / MySQL
  return {
    client,
    host: process.env.DB_HOST ?? 'localhost',
    port: optionalInt('DB_PORT', client === 'pg' ? 5432 : 3306),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
  };
}

function buildCrmDbConfig(): DbConfig {
  const client = process.env.DB_CLIENT ?? 'better-sqlite3';

  if (client === 'better-sqlite3') {
    return {
      client,
      filename: process.env.CRM_DB_FILENAME ?? './crm.db',
    };
  }

  // Postgres / MySQL — separate database on the same server
  return {
    client,
    host: process.env.DB_HOST ?? 'localhost',
    port: optionalInt('DB_PORT', client === 'pg' ? 5432 : 3306),
    database: process.env.CRM_DB_NAME ?? required('DB_NAME') + '_crm',
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
  };
}

export function buildConfig(): Config {
  return {
    port: optionalInt('PORT', 3020),
    db: buildDbConfig(),
    crmDb: buildCrmDbConfig(),
    seedOrderCount: optionalInt('SEED_ORDER_COUNT', 500),
    llm: {
      endpoint: process.env.LLM_ENDPOINT ?? 'https://api.openai.com/v1/chat/completions',
      apiKey: optional('LLM_API_KEY'),
      model: process.env.LLM_MODEL ?? 'gpt-4o',
    },
    jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
    studioToken: optional('STUDIO_TOKEN'),
    allowedOrigins: (
      process.env.ALLOWED_ORIGINS ??
      'http://localhost:3004,http://localhost:3005,http://localhost:3006'
    )
      .split(',')
      .map((s) => s.trim()),
  };
}
