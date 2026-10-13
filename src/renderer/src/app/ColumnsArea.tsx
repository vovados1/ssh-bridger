import { fsClient } from '../lib/api'
import { notify } from '../lib/toasts'
import { Column } from '../features/column/Column'
import { useConnections, useWorkspace, workspaceStore } from './stores'
import styles from './ColumnsArea.module.css'

/** The side-by-side columns: the local machine first, then one per opened connection. */
export function ColumnsArea() {
  const columns = useWorkspace((s) => s.columns)
  const states = useConnections((s) => s.states)

  return (
    <div className={styles.area}>
      {columns.map((c) => {
        const { profileId } = c
        return (
          <Column
            key={c.id}
            machineId={c.machineId}
            title={c.title}
            fs={fsClient}
            notify={notify}
            canTrash={profileId === undefined}
            {...(c.color ? { color: c.color } : {})}
            {...(profileId === undefined
              ? {}
              : {
                  connection: {
                    state: states[profileId],
                    reconnect: () => void workspaceStore.getState().reconnect(profileId)
                  },
                  onClose: () => workspaceStore.getState().closeColumn(c.id)
                })}
          />
        )
      })}
    </div>
  )
}
