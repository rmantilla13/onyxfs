'use client';

import Dialog from '@/app/components/ui/Dialog';
import { modKey } from '@/lib/keys';

/**
 * Every keyboard shortcut in the app, in one place. Opened from the account
 * menu, from the ⌘K palette, or with "?" anywhere that is not a text field.
 *
 * Each entry mirrors a handler — CommandPalette (⌘K), useSelectionModel
 * (clicking, moving and selecting in the files view), QuickLook,
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
        [['Click'], 'Select a file or folder'],
        [[`${mod}-click`], 'Add it to the selection, or take it out'],
        [['⇧-click'], 'Select everything from the last one clicked'],
        [['←', '→', '↑', '↓'], 'Move the selection'],
        [['⇧←', '⇧→', '⇧↑', '⇧↓'], 'Extend the selection'],
        [['Home', 'End'], 'First or last item'],
        [['⇧Space'], 'Add the focused item to the selection, or take it out'],
        [['Space'], 'Quick Look'],
        [['Double-click', 'Return', `${mod}↓`], 'Open'],
        [[`${mod}A`], 'Select everything in the folder'],
        [['→', '←'], 'In Columns: open the selected folder, or go back up'],
        [['Drag'], 'On empty space: select what the rectangle touches (⇧ or ' + mod + ' adds to the selection)'],
        [['Esc'], 'Clear the selection'],
        [[`${mod}I`], 'Get info'],
        [['⇧F10'], 'Menu for the file or folder in focus'],
        [['Drag'], 'Move the selection onto a folder, in the grid, the sidebar or the path'],
        [['Tap'], 'On a touch screen: open (a long press selects, then taps add)'],
      ],
    },
    {
      title: 'Quick Look',
      keys: [
        [['←', '→'], 'Previous or next'],
        [['Space', 'Esc'], 'Close'],
        [['Return'], 'Open'],
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
        [['Click'], 'On a cell of a row already selected: edit it'],
        [['Return', 'F2'], 'Edit the cell'],
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
        [['C'], 'Comment on this frame'],
      ],
    },
    {
      title: 'Anywhere',
      keys: [
        [[`${mod}K`], 'Search files, folders and drives, or run a command — on the files page, filter the view first'],
        [['↑', '↓', 'Enter'], 'In search: move, then open or run'],
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
