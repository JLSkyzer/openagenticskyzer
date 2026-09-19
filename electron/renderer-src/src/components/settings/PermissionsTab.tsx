import type { SettingsDraft } from './useSettingsDraft';
import { Group, Row, Section, Toggle } from './parts';

// Mirrors settings.py::_tab_permissions.
export function PermissionsTab({ draft }: { draft: SettingsDraft }) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <Section title="Permissions" badge="GLOBAL" />
        <Group>
          <Row label="Niveau de permission" hint="Demander = bannière | Auto = tout passer | Strict = lecture seule">
            <select
              data-setting="permission_mode"
              value={draft.get<string>('permission_mode', 'demander')}
              onChange={event => draft.set('permission_mode', event.target.value)}
              className="w-40 rounded px-2 py-1 text-xs text-gray-200 outline-none"
              style={{ background: '#1a1a1a', border: '1px solid #2a2a2a' }}
            >
              <option value="demander">Demander</option>
              <option value="auto">Auto (bypass)</option>
              <option value="strict">Strict (lecture)</option>
            </select>
          </Row>
          <Row label="Exécution shell (run_command)">
            <Toggle setting="shell_ask" checked={draft.get('shell_ask', true)} onChange={value => draft.set('shell_ask', value)} />
          </Row>
          <Row label="Écriture / suppression de fichiers">
            <Toggle setting="files_ask" checked={draft.get('files_ask', false)} onChange={value => draft.set('files_ask', value)} />
          </Row>
          <Row label="Recherche internet" last>
            <Toggle setting="search_ask" checked={draft.get('search_ask', false)} onChange={value => draft.set('search_ask', value)} />
          </Row>
        </Group>
      </div>
    </div>
  );
}
