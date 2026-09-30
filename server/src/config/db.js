import mongoose from 'mongoose';
import { config } from './env.js';
import { logger } from '../utils/logger.js';

mongoose.set('strictQuery', true);

export async function connectDB(uri = config.mongoUri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  logger.info(`MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
  return mongoose.connection;
}

let connecting = null;

/** Connect once per process and reuse it (serverless instances handle many requests). */
export function ensureDB() {
  if (mongoose.connection.readyState === 1) return Promise.resolve(mongoose.connection);
  connecting ??= connectDB().catch((err) => {
    connecting = null; // retry on the next request
    throw err;
  });
  return connecting;
}

export async function disconnectDB() {
  await mongoose.disconnect();
}

export const dbState = () => ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoose.connection.readyState] ?? 'unknown';
