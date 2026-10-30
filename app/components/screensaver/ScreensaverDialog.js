'use client';

import { Fragment, useEffect, useId, useState } from 'react';
import Dialog from '@/app/components/ui/Dialog';
import Icon from '@/app/components/ui/Icon';
import SaverView from './SaverView';
import {
  SAVERS, DELAYS, SPEEDS, MESSAGE_MAX, DEFAULT_MESSAGE,
  saverFor, readScreensaverPref, writeScreensaverPref, startScreensaverNow,
} from '@/lib/screensaver';

const SPEED_LABEL = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };
const delayLabel = (m) => (m === 60 ? '1 hour' : `${m} minute${m === 1 ? '' : 's'}`);

/**
 * The screen saver picker, from the account menu: a preview of the one
 * chosen, with Try it, a grid of all of them with Off first, and the options
 * beside — when it starts, how fast it runs, a clock in the corner, which
 * drive the pictures come from, the message. Each change is kept as it is
 * made, on this device (lib/screensaver.js), and the watcher on every page
 * hears of it at once.
 *
 * The grid's tiles are the savers themselves, drawn still; only the preview
 * moves. `drives` and `library` are the nav's: Photos and Mosaic are offered
 * All files only where there is one, and on a drive otherwise.
 */
export default function ScreensaverDialog({ open, onClose, logo, brandName, drives = [], library = null }) {
  const [pref, setPref] = useState(null);
  const ids = useId();
  useEffect(() => { if (open) setPref(readScreensaverPref()); }, [open]);

  const set = (patch) => setPref(writeScreensaverPref(patch));
  const choose = (key) => {
    const patch = { saver: key };
    // No All files to draw from: the first drive, until one is chosen.
    if (saverFor(key)?.pictures && library === false && !pref?.drive && drives[0]) patch.drive = drives[0].id;
    set(patch);
  };

  const entry = pref ? saverFor(pref.saver) : null;
  const groups = [];
  for (const s of SAVERS) {
    const g = groups.find((x) => x.name === s.group);
    if (g) g.list.push(s);
    else groups.push({ name: s.group, list: [s] });
  }
  // The preview is remade for a different saver, drive or message — a
  // Photos preview on another drive fetches again — and keeps running
  // across the options that only tune it.
  const previewKey = pref ? `${pref.saver}|${pref.drive || ''}|${pref.message}` : '';

  return (
    <Dialog open={open} onClose={onClose} title="Screen saver" wide footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
      {pref && (
        <div className="saver-picker">
          <div className="saver-picker-main">
            <div className="saver-preview">
              {open && <SaverView key={previewKey} saverKey={pref.saver} pref={pref} preview logo={logo} brandName={brandName} cornerClock={pref.clock} />}
              {pref.saver !== 'off' && (
                <button type="button" className="btn btn-sm btn-glass saver-preview-try" onClick={startScreensaverNow}>
                  <Icon name="play" size={14} />
                  Try it
                </button>
              )}
            </div>
            <p className="saver-blurb">
              {entry ? entry.blurb : 'The screen stays as it is, however long it is left.'}
            </p>
            <div className="saver-grid" role="radiogroup" aria-label="Screen saver">
              <Tile name="Off" checked={pref.saver === 'off'} onChoose={() => choose('off')}>
                <SaverView saverKey="off" pref={pref} still />
              </Tile>
              {groups.map((g) => (
                <Fragment key={g.name}>
                  <div className="eyebrow saver-group" aria-hidden="true">{g.name}</div>
                  {g.list.map((s) => (
                    <Tile key={s.key} name={s.name} checked={pref.saver === s.key} onChoose={() => choose(s.key)}>
                      <SaverView saverKey={s.key} pref={pref} still logo={logo} brandName={brandName} />
                    </Tile>
                  ))}
                </Fragment>
              ))}
            </div>
          </div>

          <aside className="saver-options" aria-label="Options">
            <label className="saver-option">
              <span className="small">Start after</span>
              <select className="input" value={pref.delay} onChange={(e) => set({ delay: Number(e.target.value) })}>
                {DELAYS.map((m) => <option key={m} value={m}>{delayLabel(m)}</option>)}
              </select>
              <span className="saver-option-hint">of nothing pressed, typed or scrolled. Never while a video is playing.</span>
            </label>

            <div className="saver-option">
              <span className="small" id={`${ids}-speed`}>Speed</span>
              <div className="seg" role="radiogroup" aria-labelledby={`${ids}-speed`}>
                {SPEEDS.map((s) => (
                  <button key={s} type="button" role="radio" aria-checked={pref.speed === s} className="seg-btn" onClick={() => set({ speed: s })}>
                    {SPEED_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>

            {!entry?.clock && pref.saver !== 'off' && (
              <div className="saver-option-row">
                <label htmlFor={`${ids}-clock`} className="small">Show the time</label>
                <input
                  id={`${ids}-clock`}
                  type="checkbox"
                  role="switch"
                  className="switch"
                  checked={pref.clock}
                  aria-checked={pref.clock}
                  onChange={(e) => set({ clock: e.target.checked })}
                />
              </div>
            )}

            {entry?.pictures && (
              <label className="saver-option">
                <span className="small">Pictures from</span>
                <select className="input" value={pref.drive || ''} onChange={(e) => set({ drive: e.target.value || null })}>
                  {library !== false && <option value="">All files</option>}
                  {drives.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                <span className="saver-option-hint">The newest pictures there, in a different order each time.</span>
              </label>
            )}

            {entry?.text && (
              <label className="saver-option">
                <span className="small">Message</span>
                <input
                  className="input"
                  value={pref.message}
                  maxLength={MESSAGE_MAX}
                  placeholder={DEFAULT_MESSAGE}
                  onChange={(e) => set({ message: e.target.value })}
                />
              </label>
            )}

            <p className="saver-option-hint">Kept on this device, like the theme. Any key, click or touch wakes the screen.</p>
          </aside>
        </div>
      )}
    </Dialog>
  );
}

function Tile({ name, checked, onChoose, children }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className="saver-tile" onClick={onChoose}>
      <span className="saver-tile-pic"><span className="saver-tile-scale">{children}</span></span>
      <span className="saver-tile-name">{name}</span>
    </button>
  );
}
