import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

dotenv.config({ path: path.join(SERVER_ROOT, process.env.NODE_ENV === 'test' ? '.env.test' : '.env'), quiet: true });

const csv = (value) => value.split(',').map((v) => v.trim()).filter(Boolean);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/sonarscan'),
  AI_SERVICE_URL: z.string().url().default('http://127.0.0.1:8000'),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  AI_API_KEY: z.string().optional(),
  CLIENT_ORIGINS: z.string().default('http://localhost:3000').transform(csv),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(100),
  STORAGE_PROVIDER: z.enum(['cloudinary', 'local']).default('cloudinary'),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default('sonarscan'),
  PUBLIC_URL: z.string().url().optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.issues);
  process.exit(1);
}
const env = parsed.data;

// Vercel (and other serverless hosts): read-only filesystem except the temp dir, one DB connection per instance.
const serverless = Boolean(process.env.VERCEL);

const cloudinaryReady = Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

export const config = {
  env: env.NODE_ENV,
  isTest: env.NODE_ENV === 'test',
  serverless,
  port: env.PORT,
  publicUrl: env.PUBLIC_URL ?? `http://localhost:${env.PORT}`,
  mongoUri: env.MONGODB_URI,
  ai: { url: env.AI_SERVICE_URL.replace(/\/$/, ''), timeoutMs: env.AI_TIMEOUT_MS, apiKey: env.AI_API_KEY || undefined },
  cors: { origins: env.CLIENT_ORIGINS },
  upload: { maxBytes: env.MAX_UPLOAD_MB * 1024 * 1024 },
  rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
  storage: {
    // Falls back to local disk when Cloudinary credentials are missing, so the backend still runs.
    provider: env.STORAGE_PROVIDER === 'cloudinary' && cloudinaryReady ? 'cloudinary' : 'local',
    requestedProvider: env.STORAGE_PROVIDER,
    // Serverless disks are ephemeral: use Cloudinary in production; this fallback only keeps the API up.
    // Tests get their own folder: the suite wipes it, and must never touch real uploads.
    localDir: serverless ? path.join(os.tmpdir(), 'sonarscan-uploads')
      : path.join(SERVER_ROOT, env.NODE_ENV === 'test' ? 'uploads-test' : 'uploads'),
    cloudinary: {
      cloudName: env.CLOUDINARY_CLOUD_NAME,
      apiKey: env.CLOUDINARY_API_KEY,
      apiSecret: env.CLOUDINARY_API_SECRET,
      folder: env.CLOUDINARY_FOLDER,
    },
  },
};
