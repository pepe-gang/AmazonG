import type { JobAttempt } from '../../shared/types.js';
import {
  effectiveStatusGroup,
  STATUS_GROUP_BADGE_CLASS,
  STATUS_GROUP_LABEL,
} from '../lib/jobsColumns.js';

/** One-shot status pill used in the Jobs table and Logs header. Takes
 *  the full attempt (not just status) so the tracking-gate in
 *  effectiveStatusGroup can demote `completed`/`verified` rows
 *  without trackingIds back into Pending — matches BG's dashboard
 *  semantics where Success means "shipped/tracked", not just
 *  "BG accepted the buy report". */
export function StatusBadge({ attempt }: { attempt: JobAttempt }) {
  const group = effectiveStatusGroup(attempt);
  return (
    <span className={`status-badge ${STATUS_GROUP_BADGE_CLASS[group]}`}>
      {STATUS_GROUP_LABEL[group]}
    </span>
  );
}
