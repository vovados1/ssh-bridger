import { ConnectErrorDialog } from '../features/connections/ConnectErrorDialog'
import { ImportDialog } from '../features/connections/ImportDialog'
import { ManageDialog } from '../features/connections/ManageDialog'
import { ProfileEditorDialog } from '../features/connections/ProfileEditorDialog'
import { SettingsDialog } from '../features/settings/SettingsDialog'
import { useWorkspace, workspaceStore } from './stores'

/** App-level dialogs opened from the toolbar and the connection manager. */
export function DialogHost() {
  const dialog = useWorkspace((s) => s.dialog)
  if (!dialog) return null
  const close = () => workspaceStore.getState().showDialog(null)

  switch (dialog.kind) {
    case 'profile':
      return (
        <ProfileEditorDialog
          key={dialog.profileId ?? 'new'}
          {...(dialog.profileId ? { profileId: dialog.profileId } : {})}
          {...(dialog.connectAfterSave ? { connectAfterSave: true } : {})}
          onClose={close}
        />
      )
    case 'manage':
      return <ManageDialog onClose={close} />
    case 'import':
      return <ImportDialog onClose={close} />
    case 'settings':
      return <SettingsDialog onClose={close} />
    case 'connectError':
      return (
        <ConnectErrorDialog profileName={dialog.profileName} error={dialog.error} onClose={close} />
      )
  }
}
