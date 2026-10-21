import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const bucket = process.env.S3_BUCKET ?? "audio";

/** MinIO audio cache (S3 API, path-style). */
export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
  },
});

export const audioKey = (videoId: string) => `m4a/${videoId}.m4a`;

export async function uploadAudio(key: string, path: string): Promise<number> {
  const { size } = await stat(path);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(path),
      ContentLength: size,
      ContentType: "audio/mp4",
    }),
  );
  return size;
}
