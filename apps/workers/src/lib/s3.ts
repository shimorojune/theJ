import { S3Client } from "bun";

/** MinIO audio cache, via Bun's built-in S3 client. */
export const audio = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  bucket: process.env.S3_BUCKET ?? "audio",
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
});

export const audioKey = (videoId: string) => `m4a/${videoId}.m4a`;
