import type { JobAttemptStatus } from '../../shared/types.js';
import { STATUS_GROUP, STATUS_GROUP_BADGE_CLASS, STATUS_GROUP_LABEL } from '../lib/jobsColumns.js';

/** One-shot status pill used in the Jobs table and Logs header. Raw
 *  status enum collapses into the 4-bucket visual taxonomy (Pending /
 *  Success / Cancelled / Failed) so the user sees fewer distinctions. */
export function StatusBadge({ status }: { status: JobAttemptStatus }) {
  const group = STATUS_GROUP[status];
  return (
    <span className={`status-badge ${STATUS_GROUP_BADGE_CLASS[group]}`}>
      {STATUS_GROUP_LABEL[group]}
    </span>
  );
}
