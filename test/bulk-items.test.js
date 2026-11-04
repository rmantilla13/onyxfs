// Acting on a selection that holds folders (lib/bulk-items.js): which
// folders a move or a delete has to act on, which a destination leaves
// where they are, what one confirmation says about them all — the part a
// mistake would cost someone a folder, or tell them Trash will keep what it
// will not — and how it says it went.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  outermostFolders, planMove, sumSummaries, describeItems, deleteWords, movedWords, deletedWords,
} from '../lib/bulk-items.js';

describe('the folders an action acts on', () => {
  test('each once, in the order picked', () => {
    assert.deepEqual(outermostFolders(['Stills', 'Footage', 'Stills']), ['Stills', 'Footage']);
  });

  test('one inside another picked folder goes with it', () => {
    assert.deepEqual(outermostFolders(['A/B/C', 'A', 'D']), ['A', 'D']);
  });

  test('a name that merely starts the same is a folder of its own', () => {
    assert.deepEqual(outermostFolders(['Projects/2024', 'Projects/2024 old']), ['Projects/2024', 'Projects/2024 old']);
  });

  test('the top level and anything that is not a path are not folders anyone picked', () => {
    assert.deepEqual(outermostFolders(['', null, undefined, 3, 'A']), ['A']);
    assert.deepEqual(outermostFolders(null), []);
    assert.deepEqual(outermostFolders(new Set(['A', 'B'])), ['A', 'B']);
  });
});

describe('moving folders into a destination', () => {
  test('folders side by side all go into another folder', () => {
    assert.deepEqual(planMove(['Work/A', 'Work/B'], 'Archive'), { move: ['Work/A', 'Work/B'], here: [], into: [] });
  });

  test('into the folder they are in already: nothing moves', () => {
    assert.deepEqual(planMove(['Work/A', 'Work/B'], 'Work'), { move: [], here: ['Work/A', 'Work/B'], into: [] });
    assert.deepEqual(planMove(['A', 'B'], ''), { move: [], here: ['A', 'B'], into: [] });
  });

  test('to the top level, from inside a folder', () => {
    assert.deepEqual(planMove(['Work/A'], '').move, ['Work/A']);
  });

  test('onto one of them, or into a folder inside one, is a folder into itself', () => {
    assert.deepEqual(planMove(['Work/A', 'Work/B'], 'Work/A').into, ['Work/A']);
    assert.deepEqual(planMove(['Work/A', 'Work/B'], 'Work/B/Q1').into, ['Work/B']);
  });

  test('into a sibling whose name starts the same is a move', () => {
    assert.deepEqual(planMove(['Work/A'], 'Work/A old').move, ['Work/A']);
  });

  test('a folder inside another one moving is not moved a second time', () => {
    assert.deepEqual(planMove(['A', 'A/B'], 'C').move, ['A']);
  });
});

test('what a delete of them all takes is each folder’s summary added up', () => {
  assert.deepEqual(sumSummaries([
    { files: 3, folders: 1, outside: 0 },
    { files: 10, folders: 0, outside: 2 },
    {},
    null,
  ]), { files: 13, folders: 1, outside: 2 });
  assert.deepEqual(sumSummaries([]), { files: 0, folders: 0, outside: 0 });
});

describe('how many of what', () => {
  test('one kind says which', () => {
    assert.equal(describeItems({ folders: 1 }), '1 folder');
    assert.equal(describeItems({ folders: 3 }), '3 folders');
    assert.equal(describeItems({ files: 1 }), '1 file');
    assert.equal(describeItems({ files: 4 }), '4 files');
  });

  test('folders and files together are items — or, exactly, both', () => {
    assert.equal(describeItems({ folders: 2, files: 3 }), '5 items');
    assert.equal(describeItems({ folders: 2, files: 3 }, { exact: true }), '2 folders and 3 files');
    assert.equal(describeItems({ folders: 1, files: 1 }, { exact: true }), '1 folder and 1 file');
  });

  test('large counts are grouped', () => {
    assert.equal(describeItems({ files: 1200 }), '1,200 files');
  });
});

describe('the one confirmation for deleting several', () => {
  test('with Trash: what they hold, where it goes, and what is not kept', () => {
    const w = deleteWords({ folders: 3, inside: { files: 40, folders: 5 }, trash: true, days: 30 });
    assert.equal(w.title, 'Delete 3 folders?');
    assert.equal(w.confirmLabel, 'Delete 3 folders');
    assert.equal(w.body, 'They hold 40 files and 5 subfolders. The files go to Trash, where you can restore them for 30 days; the folders’ own tags, notes and stars are not kept.');
  });

  test('without Trash it says, plainly, that it cannot be undone', () => {
    const w = deleteWords({ folders: 2, inside: { files: 12 }, trash: false });
    assert.match(w.body, /^They hold 12 files\. All 12 files will be permanently deleted\. This cannot be undone\.$/);
    assert.doesNotMatch(w.body, /Trash/);
  });

  test('never promises Trash for a delete that is for good, nor the reverse', () => {
    for (const inside of [{ files: 1 }, { files: 7, folders: 2 }]) {
      assert.doesNotMatch(deleteWords({ folders: 2, inside, trash: false }).body, /restore/);
      assert.doesNotMatch(deleteWords({ folders: 2, inside, trash: true }).body, /cannot be undone/);
    }
  });

  test('empty folders are said to be empty, with nothing about files', () => {
    const w = deleteWords({ folders: 2, inside: {}, trash: true });
    assert.equal(w.body, 'They are empty.');
  });

  test('files picked with the folders are named in the title and counted with theirs', () => {
    const w = deleteWords({ folders: 2, files: 3, inside: { files: 10 }, trash: true, days: 30 });
    assert.equal(w.title, 'Delete 2 folders and 3 files?');
    assert.equal(w.confirmLabel, 'Delete 5 items');
    assert.match(w.body, /^The folders hold 10 files\. The files go to Trash/);
    const empty = deleteWords({ folders: 1, files: 1, inside: {}, trash: false });
    assert.equal(empty.body, 'The folder is empty. The file will be permanently deleted. This cannot be undone.');
  });

  test('files from another filespace at those paths stay, and it says so', () => {
    assert.match(deleteWords({ folders: 2, inside: { files: 1, outside: 3 }, trash: true }).body, /3 files from another filespace at these paths will stay\.$/);
  });
});

describe('how it went', () => {
  test('a move of all of it', () => {
    assert.equal(movedWords({ folders: [3, 3] }, 'Archive'), 'Moved 3 folders to Archive.');
    assert.equal(movedWords({ folders: [2, 2], files: [4, 4] }, 'Archive'), 'Moved 2 folders and 4 files to Archive.');
  });

  test('a move of some of it says how many of how many', () => {
    assert.equal(movedWords({ folders: [2, 3], files: [1, 1] }, 'All files'), 'Moved 2 of 3 folders and 1 file to All files.');
  });

  test('a move where nothing went says nothing of the kind', () => {
    assert.equal(movedWords({ folders: [0, 2], files: [0, 0] }, 'Archive'), null);
    assert.equal(movedWords({ folders: [0, 2], files: [3, 3] }, 'Archive'), 'Moved 3 files to Archive.');
  });

  test('a delete, to Trash or for good', () => {
    assert.equal(deletedWords({ folders: [3, 3], files: 42, trash: true }), 'Deleted 3 folders and moved 42 files to Trash.');
    assert.equal(deletedWords({ folders: [3, 3], files: 42, trash: false }), 'Deleted 3 folders and 42 files.');
    assert.equal(deletedWords({ folders: [2, 2] }), 'Deleted 2 folders.');
    assert.equal(deletedWords({ folders: [1, 2], files: 1, trash: true }), 'Deleted 1 of 2 folders and moved 1 file to Trash.');
  });

  test('a delete where no folder went', () => {
    assert.equal(deletedWords({ folders: [0, 2], files: 2, trash: true }), 'Moved 2 files to Trash.');
    assert.equal(deletedWords({ folders: [0, 2] }), null);
  });
});
