import { fsClient } from '../lib/api'
import { notify } from '../lib/toasts'
import { Column } from '../features/column/Column'
import styles from './ColumnsArea.module.css'

/** Hosts the side-by-side columns. One local column until M4 adds more. */
export function ColumnsArea() {
  return (
    <div className={styles.area}>
      <Column machineId="local" title="Local" fs={fsClient} notify={notify} />
    </div>
  )
}
