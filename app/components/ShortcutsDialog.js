'use client';

import Dialog from '@/app/components/ui/Dialog';
import { modKey } from '@/lib/keys';

/**
 * Every keyboard shortcut in the app, in one place. Opened from the nav's
 * Shortcuts button or with "?" anywhere that is not a text field.
 *
 * Each entry mirrors a handler — FileGrid / FileList (moving and selecting),
 * FilesClient (⌘↑, ⌘I, the menu key), FileList's cell editors, VideoPlayer —
 * so a change to one of those belongs here too. The modifier is the viewer's
 * platform's, which is why this renders only when opened, in the browser.
 */
function groups(mod) {
  const mac = mod === '⌘';
  return [
    {
      title: 'Files',
      keys: [
        [['←', '→', '↑', '↓'], 'Move between files'],
        [['Home', 'End'], 'First or last file'],
        [['Space'], 'Select or deselect'],
        [['Enter'], 'Open'],
        [[`${mod}I`], 'Get info'],
        [['⇧F10'], 'Menu for the file or folder in focus'],
      ],
    },
    {
      title: 'Folders',
      keys: [
        [[`${mod}↑`], 'Enclosing folder'],
        [[mac ? '⌘[' : 'Alt+←'], 'Back'],
        [[mac ? '⌘]' : 'Alt+→'], 'Forward'],
      ],
    },
    {
      title: 'List view',
      keys: [
        [['Tab'], "Move into a row's editable cells"],
        [['Enter', 'F2'], 'Edit the cell'],
        [['Enter'], 'Save'],
        [['Esc'], 'Cancel'],
      ],
    },
    {
      title: 'Video player',
      note: 'Click the player first.',
      keys: [
        [['Space', 'K'], 'Play or pause'],
        [['J', 'L'], 'Shuttle back or forward (again for faster)'],
        [[',', '.'], 'Previous or next frame'],
        [['←', '→'], 'Back or forward 5 seconds (⇧ for 1)'],
        [['↑', '↓'], 'Volume'],
        [['I', 'O'], 'Set in or out point'],
        [['⇧X'], 'Clear in and out'],
        [['0–9'], 'Jump to 0–90%'],
        [['Home', 'End'], 'Start or end'],
        [['M'], 'Mute'],
        [['F'], 'Fullscreen'],
      ],
    },
    {
      title: 'Anywhere',
      keys: [
        [['?'], 'These shortcuts'],
        [['Esc'], 'Close a dialog or menu'],
      ],
    },
  ];
}

export default function ShortcutsDialog({ open, onClose }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" wide>
      {open && (
        <div className="shortcuts">
          {groups(modKey()).map((g) => (
            <section key={g.title} className="shortcuts-group">
              <h3 className="shortcuts-title">{g.title}</h3>
              {g.note && <p className="small muted" style={{ margin: '0 0 var(--s2)' }}>{g.note}</p>}
              <dl className="shortcuts-list">
                {g.keys.map(([keys, what]) => (
                  <div key={`${keys.join()}${what}`} className="shortcuts-row">
                    <dt>
                      {keys.map((k, i) => (
                        <span key={k}>
                          {i > 0 && <span className="muted"> </span>}
                          <kbd>{k}</kbd>
                        </span>
                      ))}
                    </dt>
                    <dd className="small">{what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  );
}
