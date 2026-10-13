import type { MachineId } from '@shared/fs-types'
import { profileIdOf } from '@shared/connections'
import { ACTIVE_STATUSES, type JobSnapshot } from '@shared/transfers'
import { transfersStore, useConnections, useTransfers } from '../../app/stores'
import {
  jobProgress,
  jobTitle,
  progressDetail,
  statusText,
  summarize,
  formatSpeed
} from './transferFormat'
import styles from './TransferPanel.module.css'

/** The bar at the bottom: a one-line summary that expands into every job. */
export function TransferPanel() {
  const jobs = useTransfers((s) => s.jobs)
  const open = useTransfers((s) => s.panelOpen)
  const profiles = useConnections((s) => s.profiles)

  if (jobs.length === 0) return null

  const machineName = (id: MachineId): string => {
    const profileId = profileIdOf(id)
    return profileId === null
      ? 'Local'
      : (profiles.find((p) => p.id === profileId)?.name ?? 'Remote')
  }
  const summary = summarize(jobs)
  const toggle = () => transfersStore.getState().setPanelOpen(!open)

  return (
    <section className={styles.panel} aria-label="Transfers">
      <div className={styles.summary}>
        <button className={styles.toggle} onClick={toggle} aria-expanded={open}>
          <span aria-hidden>{open ? '▾' : '▸'}</span>
          <span className={styles.icon} aria-hidden>
            ⇅
          </span>
          {summary.active > 0 ? (
            <>
              <span>
                {summary.active} {summary.active === 1 ? 'transfer' : 'transfers'} in progress
              </span>
              {summary.speed > 0 && (
                <span className={styles.muted}>{formatSpeed(summary.speed)}</span>
              )}
            </>
          ) : (
            <span>
              {summary.finished} finished
              {summary.errors > 0 && (
                <span className={styles.errorText}> · {summary.errors} with errors</span>
              )}
            </span>
          )}
        </button>
        {summary.active > 0 && (
          <progress
            className={styles.bar}
            max={1}
            value={summary.progress}
            aria-label="Overall progress"
          />
        )}
        {summary.finished > 0 && (
          <button className={styles.link} onClick={() => transfersStore.getState().clear()}>
            Clear finished
          </button>
        )}
      </div>
      {open && (
        <ul className={styles.list}>
          {[...jobs].reverse().map((job) => (
            <JobRow key={job.id} job={job} machineName={machineName} />
          ))}
        </ul>
      )}
    </section>
  )
}

function JobRow({
  job,
  machineName
}: {
  job: JobSnapshot
  machineName: (id: MachineId) => string
}) {
  const active = ACTIVE_STATUSES.includes(job.status)
  const actions = transfersStore.getState()

  return (
    <li className={styles.job} data-status={job.status}>
      <div className={styles.jobHead}>
        <span className={styles.title} title={jobTitle(job, machineName)}>
          {jobTitle(job, machineName)}
        </span>
        <span className={styles.status}>{statusText(job)}</span>
        <span className={styles.actions}>
          {active && <button onClick={() => actions.cancel(job.id)}>Cancel</button>}
          {!active && (job.status === 'error' || job.status === 'cancelled') && (
            <button onClick={() => void actions.retry(job.id)}>Retry</button>
          )}
          {!active && (
            <button onClick={() => actions.clear(job.id)} aria-label="Dismiss" title="Dismiss">
              ×
            </button>
          )}
        </span>
      </div>
      <progress
        className={styles.bar}
        max={1}
        value={jobProgress(job)}
        data-status={job.status}
        aria-label="Progress"
      />
      <div className={styles.detail}>
        <span>{progressDetail(job)}</span>
        {job.current.length > 0 && <span className={styles.current}>{job.current.join(', ')}</span>}
      </div>
      {job.errorCount > 0 && (
        <details className={styles.errors}>
          <summary>
            {job.errorCount} {job.errorCount === 1 ? 'problem' : 'problems'}
          </summary>
          <ul>
            {job.errors.slice(0, 10).map((e, i) => (
              <li key={i}>
                <code>{e.path}</code>
                <span>{e.message}</span>
              </li>
            ))}
            {job.errorCount > Math.min(10, job.errors.length) && (
              <li className={styles.muted}>
                …and {job.errorCount - Math.min(10, job.errors.length)} more
              </li>
            )}
          </ul>
        </details>
      )}
    </li>
  )
}
