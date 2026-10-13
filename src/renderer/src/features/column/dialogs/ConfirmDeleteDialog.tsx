import { Dialog } from '../Dialog'

const SHOWN = 5

interface Props {
  names: string[]
  onConfirm(): void
  onClose(): void
}

/** Permanent deletion is the only delete that asks; Trash is undoable. */
export function ConfirmDeleteDialog({ names, onConfirm, onClose }: Props) {
  const many = names.length > 1
  return (
    <Dialog
      title={many ? `Delete ${names.length} items permanently?` : 'Delete permanently?'}
      onClose={onClose}
      footer={
        <>
          {/* Cancel is focused first so a stray Enter can't destroy data. */}
          <button autoFocus onClick={onClose}>
            Cancel
          </button>
          <button
            data-danger="true"
            onClick={() => {
              onClose()
              onConfirm()
            }}
          >
            Delete
          </button>
        </>
      }
    >
      <p style={{ margin: '0 0 8px' }}>
        {many ? 'These items' : 'This item'} will be deleted immediately and cannot be recovered.
      </p>
      <ul style={{ margin: 0, paddingLeft: 20 }}>
        {names.slice(0, SHOWN).map((n) => (
          <li key={n} style={{ overflowWrap: 'anywhere' }}>
            {n}
          </li>
        ))}
        {names.length > SHOWN && <li>…and {names.length - SHOWN} more</li>}
      </ul>
    </Dialog>
  )
}
