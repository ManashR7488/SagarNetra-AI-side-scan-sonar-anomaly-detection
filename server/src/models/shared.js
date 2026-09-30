import mongoose from 'mongoose';

const { Schema } = mongoose;

/** GeoJSON Point: coordinates are [longitude, latitude]. */
export const pointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], required: true, default: 'Point' },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: ([lon, lat] = []) => Math.abs(lon) <= 180 && Math.abs(lat) <= 90,
        message: 'coordinates must be [longitude, latitude]',
      },
    },
  },
  { _id: false },
);

export const lineStringSchema = new Schema(
  {
    type: { type: String, enum: ['LineString'], required: true, default: 'LineString' },
    coordinates: { type: [[Number]], required: true },
  },
  { _id: false },
);

/** A file kept in Cloudinary (or on local disk as a fallback). */
export const storedFileSchema = new Schema(
  {
    provider: { type: String, enum: ['cloudinary', 'local'], required: true },
    url: { type: String, required: true },
    publicId: { type: String, required: true }, // Cloudinary public_id or local relative path
    resourceType: { type: String, enum: ['image', 'raw'], default: 'image' },
    format: String,
    bytes: Number,
    width: Number,
    height: Number,
  },
  { _id: false },
);

/** Hide internals and expose `id` in API responses. */
export function toJSONOptions() {
  return {
    virtuals: true,
    versionKey: false,
    transform: (_doc, ret) => {
      delete ret._id;
      return ret;
    },
  };
}
