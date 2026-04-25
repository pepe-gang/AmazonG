import type { AmazonProfile, JobAttempt } from '../../shared/types.js';
import { ActiveJobsPanel } from '../components/ActiveJobsPanel.js';
import { JobsTable } from '../components/JobsTable.js';

/* ============================================================
   Purchases view (full page)
   JobsTable plus the same Active jobs panel as the dashboard, so
   the in-flight jobs surface in both places. The panel renders
   nothing when there are no active rows, so on a quiet account
   this view is just the table.
   ============================================================ */
export function PurchasesView({
  attempts,
  profiles,
  workerRunning,
  onViewLogs,
}: {
  attempts: JobAttempt[];
  profiles: AmazonProfile[];
  workerRunning: boolean;
  onViewLogs: (a: JobAttempt) => void;
}) {
  return (
    <div className="flex flex-1 flex-col gap-3 p-5 min-h-0">
      <ActiveJobsPanel attempts={attempts} profiles={profiles} />
      <section className="glass flex flex-1 min-h-0 flex-col overflow-hidden">
        <JobsTable
          attempts={attempts}
          profiles={profiles}
          onViewLogs={onViewLogs}
          workerRunning={workerRunning}
        />
      </section>
    </div>
  );
}
