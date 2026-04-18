/** Stable id used by both the worker (writes) and the main process (reads)
 *  to look up a per-(job, profile) record on disk and route logs to it. */
export function makeAttemptId(jobId: string, email: string): string {
  return `${jobId}__${sanitizeProfileKey(email)}`;
}

/** Filename-safe slug for an Amazon email — collapses anything that could
 *  upset cross-platform filesystems while keeping the email recognizable. */
export function sanitizeProfileKey(email: string): string {
  return email.replace(/[^a-zA-Z0-9@._-]/g, '_');
}
