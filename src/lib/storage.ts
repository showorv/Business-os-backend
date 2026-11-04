import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../app/config/env.config.js";

const UPLOAD_URL_TTL_SECONDS = 15 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

const client = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  // MinIO serves buckets under the path. R2 and S3 accept this too.
  forcePathStyle: true,
  // Otherwise the SDK adds a checksum to signed URLs that browsers cannot produce.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  maxAttempts: 2,
  requestHandler: { connectionTimeout: 2000, requestTimeout: 30_000 },
});

export const checkStorage = () => client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));

// For local MinIO and tests. Production buckets are created ahead of time.
export const ensureBucket = async () => {
  try {
    await checkStorage();
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
  }
};

// The client uploads straight to storage, so large files never pass through the API.
// Signing the type and length means the upload must match what was declared.
export const createUploadUrl = async (key: string, mime: string, sizeBytes: number) => ({
  uploadUrl: await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: mime, ContentLength: sizeBytes }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS, signableHeaders: new Set(["content-type", "content-length"]) },
  ),
  expiresIn: UPLOAD_URL_TTL_SECONDS,
});

// Always served as an attachment, so a stored file can never run as a page in the browser.
export const createDownloadUrl = async (key: string, fileName: string) => ({
  url: await getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  ),
  expiresIn: DOWNLOAD_URL_TTL_SECONDS,
});

// Returns null when the object was never uploaded.
export const openObjectStream = async (key: string) => {
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return object.Body as AsyncIterable<Uint8Array>;
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey") return null;
    throw error;
  }
};

export const deleteObject = (key: string) => client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
