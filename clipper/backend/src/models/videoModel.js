import { query } from "../infra/db.js";

export async function createVideo(filename, originalKey) {
  const result = await query(
    "INSERT INTO videos (filename, original_key, status) VALUES ($1, $2, $3) RETURNING *",
    [filename, originalKey, "pending"]
  );
  return result.rows[0];
}

export async function getVideo(id) {
  const result = await query("SELECT * FROM videos WHERE id = $1", [id]);
  return result.rows[0];
}

export async function updateVideoStatus(id, status) {
  const result = await query(
    "UPDATE videos SET status = $1 WHERE id = $2 RETURNING *",
    [status, id]
  );
  return result.rows[0];
}

export async function getAllVideos() {
  const result = await query("SELECT * FROM videos ORDER BY created_at DESC");
  return result.rows;
}

export async function createJob(videoId, type) {
  const result = await query(
    "INSERT INTO jobs (video_id, type, status) VALUES ($1, $2, $3) RETURNING *",
    [videoId, type, "queued"]
  );
  return result.rows[0];
}

export async function updateJobStatus(id, status, errorMessage = null) {
  const result = await query(
    "UPDATE jobs SET status = $1, error_message = $2 WHERE id = $3 RETURNING *",
    [status, errorMessage, id]
  );
  return result.rows[0];
}

export async function getJobsByVideoId(videoId) {
  const result = await query(
    "SELECT * FROM jobs WHERE video_id = $1 ORDER BY created_at",
    [videoId]
  );
  return result.rows;
}

// Find jobs stuck in "queued" status for more than 1 minute (orphaned)
export async function getOrphanedJobs() {
  const result = await query(
    "SELECT j.*, v.original_key FROM jobs j JOIN videos v ON j.video_id = v.id WHERE j.status = 'queued' AND j.created_at < NOW() - INTERVAL '1 minute'",
    []
  );
  return result.rows;
}

