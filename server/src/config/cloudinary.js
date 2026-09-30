import { v2 as cloudinary } from 'cloudinary';
import { config } from './env.js';

const { cloudName, apiKey, apiSecret } = config.storage.cloudinary;

if (config.storage.provider === 'cloudinary') {
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
}

export { cloudinary };
