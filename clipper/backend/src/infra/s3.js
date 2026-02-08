import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { log } from "../utils/log.js";

let client = null;

function getClient() {
  if (!client) {
    client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test"
      },
      forcePathStyle: true
    });
  }
  return client;
}

function getBucket() {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("S3_BUCKET environment variable is not set");
  }
  return bucket;
}

export async function uploadFile(key, body, contentType) {
  try {
    const bucket = getBucket();
    await getClient().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType
    }));
    return { bucket, key };
  } catch (err) {
    log("error", {
      error_code: "S3_UPLOAD_FAILED",
      message: err.message,
      key
    });
    throw err;
  }
}

export async function downloadFile(key) {
  try {
    const bucket = getBucket();
    const response = await getClient().send(new GetObjectCommand({
      Bucket: bucket,
      Key: key
    }));
    return response.Body;
  } catch (err) {
    log("error", {
      error_code: "S3_DOWNLOAD_FAILED",
      message: err.message,
      key
    });
    throw err;
  }
}
