// The rules of review, without a database: who may do what, what a comment
// and a drawing may hold, how a status is derived, and the geometry that
// keeps a drawing on the thing it circles.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewDecision, deriveReviewStatus, validateAnnotation, validateComment, validateDecision,
  normalizeMentions, commentFrame, anchorLabel, containRect, pointOnPicture, snippet, userReviewer,
  BODY_MAX,
} from '../lib/review.js';
import { secondsOfFrame, frameAt } from '../lib/video-time.js';

describe('reviewDecision', () => {
  const reader = { flagOn: true, canRead: true, canModify: false };
  const editor = { flagOn: true, canRead: true, canModify: true };

  test('the flag, read on the server, closes everything', () => {
    for (const action of ['read', 'comment', 'decide', 'mention', 'edit', 'delete', 'resolve']) {
      const d = reviewDecision(action, { ...editor, flagOn: false, isAuthor: true });
      assert.equal(d.ok, false, action);
      assert.equal(d.status, 403);
    }
    // Absent is off: nothing is allowed by forgetting to pass it.
    assert.equal(reviewDecision('read', { canRead: true }).ok, false);
  });

  test('without read access, nothing — however much else is true', () => {
    for (const action of ['read', 'comment', 'decide', 'mention', 'edit', 'delete', 'resolve']) {
      const d = reviewDecision(action, { flagOn: true, canRead: false, canModify: true, isAuthor: true });
      assert.equal(d.ok, false, action);
      assert.equal(d.status, 403);
    }
  });

  test('reading is enough to read, comment, decide and mention', () => {
    for (const action of ['read', 'comment', 'decide', 'mention']) assert.equal(reviewDecision(action, reader).ok, true, action);
  });

  test('only the author edits', () => {
    assert.equal(reviewDecision('edit', { ...reader, isAuthor: true }).ok, true);
    assert.equal(reviewDecision('edit', { ...editor, isAuthor: false }).ok, false, 'not even someone who may change the file');
  });

  test('deleting and resolving: the author, or whoever may change the file', () => {
    for (const action of ['delete', 'resolve']) {
      assert.equal(reviewDecision(action, { ...reader, isAuthor: true }).ok, true);
      assert.equal(reviewDecision(action, { ...editor, isAuthor: false }).ok, true);
      assert.equal(reviewDecision(action, { ...reader, isAuthor: false }).ok, false);
    }
  });

  test('an unknown action is refused, not allowed', () => {
    assert.equal(reviewDecision('purge', editor).ok, false);
  });
});

describe('deriveReviewStatus', () => {
  test('changes requested outweighs any number of approvals', () => {
    assert.equal(deriveReviewStatus({ changes: 1, approved: 9, live: 3 }), 'changes_requested');
  });
  test('approved, then in review, then nothing', () => {
    assert.equal(deriveReviewStatus({ approved: 1 }), 'approved');
    assert.equal(deriveReviewStatus({ live: 2 }), 'in_review');
    assert.equal(deriveReviewStatus({ links: 1 }), 'in_review');
    assert.equal(deriveReviewStatus({}), null);
    assert.equal(deriveReviewStatus({ live: 0, approved: 0, changes: 0 }), null);
  });
});

describe('validateAnnotation', () => {
  const ok = { v: 1, srcW: 3840, srcH: 2160, shapes: [{ t: 'arrow', c: 0, w: 3, pts: [[0.41, 0.22], [0.47, 0.31]] }] };

  test('keeps a sane drawing, rounded', () => {
    const { value } = validateAnnotation({
      ...ok,
      shapes: [{ t: 'pen', c: 5, w: 2.345, pts: [[0.123456789, 0.5], [0.2, 0.25]] }, { t: 'rect', c: 1, w: 3, pts: [[0, 0], [1, 1]] }],
    });
    assert.deepEqual(value.shapes[0], { t: 'pen', c: 5, w: 2.3, pts: [[0.1235, 0.5], [0.2, 0.25]] });
    assert.deepEqual(value.shapes[1].pts, [[0, 0], [1, 1]]);
    assert.equal(value.srcW, 3840);
  });

  test('nothing, or no shapes, is no drawing', () => {
    assert.deepEqual(validateAnnotation(null), { value: null });
    assert.deepEqual(validateAnnotation(undefined), { value: null });
    assert.deepEqual(validateAnnotation({ ...ok, shapes: [] }), { value: null });
  });

  test('a point off the picture is refused, not clamped', () => {
    for (const pt of [[1.3, 0.5], [-0.01, 0.5], [0.5, 2], [NaN, 0.5], ['x', 0.5]]) {
      const r = validateAnnotation({ ...ok, shapes: [{ t: 'pen', c: 0, w: 3, pts: [pt] }] });
      assert.ok(r.error, JSON.stringify(pt));
    }
  });

  test('colour is a palette index, never a colour', () => {
    for (const c of [-1, 6, 1.5, '#ff0000', 'red', null]) {
      assert.ok(validateAnnotation({ ...ok, shapes: [{ ...ok.shapes[0], c }] }).error, String(c));
    }
  });

  test('shapes are what the tools make', () => {
    assert.ok(validateAnnotation({ ...ok, shapes: [{ ...ok.shapes[0], t: 'ellipse' }] }).error);
    assert.ok(validateAnnotation({ ...ok, shapes: [{ ...ok.shapes[0], pts: [[0.1, 0.1]] }] }).error, 'an arrow has two ends');
    assert.ok(validateAnnotation({ ...ok, shapes: [{ ...ok.shapes[0], t: 'rect', pts: [[0, 0], [0.5, 0.5], [1, 1]] }] }).error);
    assert.ok(validateAnnotation({ ...ok, shapes: [{ ...ok.shapes[0], w: 0 }] }).error);
    assert.ok(validateAnnotation({ ...ok, shapes: [{ ...ok.shapes[0], w: 99 }] }).error);
  });

  test('bounded in size', () => {
    const pen = { t: 'pen', c: 0, w: 2, pts: Array.from({ length: 2001 }, () => [0.5, 0.5]) };
    assert.ok(validateAnnotation({ ...ok, shapes: [pen] }).error);
    assert.ok(validateAnnotation({ ...ok, shapes: Array.from({ length: 51 }, () => ok.shapes[0]) }).error);
    const many = Array.from({ length: 6 }, () => ({ t: 'pen', c: 0, w: 2, pts: Array.from({ length: 1900 }, () => [0.5, 0.5]) }));
    assert.ok(validateAnnotation({ ...ok, shapes: many }).error, 'over the total point budget');
  });

  test('the envelope is checked', () => {
    assert.ok(validateAnnotation({ ...ok, v: 2 }).error);
    assert.ok(validateAnnotation({ ...ok, srcW: 0 }).error);
    assert.ok(validateAnnotation({ ...ok, srcH: 1.5 }).error);
    assert.ok(validateAnnotation([ok]).error);
    assert.ok(validateAnnotation('x').error);
    assert.ok(validateAnnotation({ v: 1, srcW: 10, srcH: 10 }).error);
  });
});

describe('validateComment', () => {
  const fps = { num: 24000, den: 1001 };
  const drawing = { v: 1, srcW: 1920, srcH: 1080, shapes: [{ t: 'rect', c: 2, w: 3, pts: [[0.1, 0.1], [0.4, 0.4]] }] };

  test('a frame comment on a video', () => {
    const { value } = validateComment({ body: ' Too dark ', anchor: 'frame', frameIn: 1439, fps }, { kind: 'video' });
    assert.equal(value.body, 'Too dark');
    assert.equal(value.anchor, 'frame');
    assert.equal(value.frameIn, 1439);
    assert.equal(value.frameOut, null);
    assert.deepEqual(value.fps, fps);
    assert.equal(value.audience, 'all');
  });

  test('a range ends after it starts', () => {
    assert.ok(validateComment({ body: 'x', anchor: 'range', frameIn: 10, frameOut: 10, fps }, { kind: 'video' }).error);
    assert.ok(validateComment({ body: 'x', anchor: 'range', frameIn: 10, frameOut: 9, fps }, { kind: 'video' }).error);
    assert.equal(validateComment({ body: 'x', anchor: 'range', frameIn: 10, frameOut: 11, fps }, { kind: 'video' }).value.frameOut, 11);
  });

  test('a frame needs the rate it was counted at, and has to be a real frame', () => {
    assert.ok(validateComment({ body: 'x', anchor: 'frame', frameIn: 3 }, { kind: 'video' }).error);
    for (const frameIn of [-1, 1.5, 'x', null]) {
      assert.ok(validateComment({ body: 'x', anchor: 'frame', frameIn, fps }, { kind: 'video' }).error, String(frameIn));
    }
  });

  test('past the end is refused, judged on the file’s own rate', () => {
    const opts = { kind: 'video', rate: { num: 24, den: 1 }, totalFrames: 240 };
    assert.ok(validateComment({ body: 'x', anchor: 'frame', frameIn: 500, fps: 24 }, opts).error);
    assert.ok(validateComment({ body: 'x', anchor: 'frame', frameIn: 239, fps: 24 }, opts).value);
    // Counted at an assumed 30: frame 290 is 9.68s, frame 232 at 24fps. Fine.
    assert.ok(validateComment({ body: 'x', anchor: 'frame', frameIn: 290, fps: 30 }, opts).value);
  });

  test('frames are for video and pins are for images', () => {
    assert.ok(validateComment({ body: 'x', anchor: 'frame', frameIn: 1, fps }, { kind: 'image' }).error);
    assert.ok(validateComment({ body: 'x', anchor: 'point', pointX: 0.5, pointY: 0.5 }, { kind: 'video' }).error);
    const { value } = validateComment({ body: 'here', anchor: 'point', pointX: 0.123456, pointY: 1 }, { kind: 'image' });
    assert.deepEqual([value.pointX, value.pointY, value.frameIn], [0.1235, 1, null]);
    assert.ok(validateComment({ body: 'x', anchor: 'point', pointX: 1.2, pointY: 0.5 }, { kind: 'image' }).error);
  });

  test('a drawing on a video needs its frame; on an image it does not', () => {
    assert.ok(validateComment({ body: '', annotation: drawing }, { kind: 'video' }).error);
    assert.ok(validateComment({ body: '', anchor: 'frame', frameIn: 4, fps, annotation: drawing }, { kind: 'video' }).value);
    assert.ok(validateComment({ body: '', annotation: drawing }, { kind: 'image' }).value, 'a drawing can stand without words');
  });

  test('words or a drawing, and not too many words', () => {
    assert.ok(validateComment({ body: '   ' }, { kind: 'image' }).error);
    assert.ok(validateComment({ body: 'x'.repeat(BODY_MAX + 1) }, { kind: 'image' }).error);
    assert.equal(validateComment({ body: 'a\r\nb' }, { kind: 'image' }).value.body, 'a\nb');
  });

  test('an unknown anchor or audience is refused', () => {
    assert.ok(validateComment({ body: 'x', anchor: 'region' }, { kind: 'image' }).error);
    assert.ok(validateComment({ body: 'x', audience: 'public' }, { kind: 'image' }).error);
    assert.equal(validateComment({ body: 'x', audience: 'internal' }, { kind: 'image' }).value.audience, 'internal');
  });

  test('a reply has no anchor and no drawing of its own', () => {
    const { value } = validateComment({ body: 'agreed', anchor: 'frame', frameIn: 5, fps, parentId: 'p1' }, { kind: 'video', isReply: true });
    assert.equal(value.anchor, 'general');
    assert.equal(value.frameIn, null);
    assert.equal(value.parentId, 'p1');
    assert.ok(validateComment({ body: 'x', annotation: drawing }, { kind: 'image', isReply: true }).error);
    assert.ok(validateComment({ body: '' }, { kind: 'image', isReply: true }).error);
  });

  test('mentions are distinct lowercased addresses, and bounded', () => {
    assert.deepEqual(normalizeMentions(['A@x.io', 'a@x.io', 'nope', '', null, 'b@y.co']), ['a@x.io', 'b@y.co']);
    assert.equal(normalizeMentions(Array.from({ length: 40 }, (_, i) => `p${i}@x.io`)).length, 20);
    assert.deepEqual(normalizeMentions('a@x.io'), []);
  });
});

describe('validateDecision', () => {
  test('approve, request changes, or withdraw', () => {
    assert.deepEqual(validateDecision({ status: 'approved' }).value, { status: 'approved', note: null });
    assert.deepEqual(validateDecision({ status: 'changes_requested', note: ' fix the logo ' }).value, { status: 'changes_requested', note: 'fix the logo' });
    assert.deepEqual(validateDecision({ status: null }).value, { status: null, note: null });
    assert.ok(validateDecision({ status: 'maybe' }).error);
    assert.ok(validateDecision({}).error, 'absent is not withdraw');
    assert.ok(validateDecision({ status: 'approved', note: 'x'.repeat(1001) }).error);
  });
});

describe('a comment’s frame on the file’s rate', () => {
  test('the same rate is the same frame', () => {
    assert.equal(commentFrame(1439, { num: 24000, den: 1001 }, { num: 24000, den: 1001 }), 1439);
  });

  test('a frame counted at an assumed 30 lands on the frame that was on screen', () => {
    // Commented before the file was probed: frame 300 at 30fps is 10.0167s.
    // At the real 23.976 that instant is frame 240.
    const f = commentFrame(300, { num: 30, den: 1 }, { num: 24000, den: 1001 });
    assert.equal(f, frameAt(secondsOfFrame(300, 30), { num: 24000, den: 1001 }));
    assert.equal(f, 240);
  });

  test('labels', () => {
    const model = { fps: { num: 24, den: 1 }, tcStart: 86400 };
    assert.equal(anchorLabel({ anchor: 'frame', frameIn: 292, fps: { num: 24, den: 1 } }, model), '01:00:12:04');
    assert.equal(
      anchorLabel({ anchor: 'range', frameIn: 292, frameOut: 370, fps: { num: 24, den: 1 } }, model),
      'In 01:00:12:04 → Out 01:00:15:10',
    );
    assert.equal(anchorLabel({ anchor: 'point' }, model), 'Pin');
    assert.equal(anchorLabel({ anchor: 'general' }, model), 'General');
    const df = { fps: { num: 30000, den: 1001 }, tcStart: 107892, dropFrame: true };
    assert.equal(anchorLabel({ anchor: 'frame', frameIn: 1800, fps: df.fps }, df), '01:01:00;02');
  });
});

describe('containRect — where the picture is inside its stage', () => {
  const close = (a, b) => Object.keys(b).forEach((k) => assert.ok(Math.abs(a[k] - b[k]) < 1e-9, `${k}: ${a[k]} != ${b[k]}`));

  test('16:9 in a 16:9 stage fills it', () => {
    close(containRect(1600, 900, 3840, 2160), { x: 0, y: 0, width: 1600, height: 900 });
  });

  test('letterboxed: scope footage in a 16:9 stage has bars above and below', () => {
    // 2.39:1 in 1600x900: 1600 wide, 669.46 tall, centred.
    const r = containRect(1600, 900, 2048, 858);
    close(r, { x: 0, width: 1600, height: 1600 * 858 / 2048, y: (900 - 1600 * 858 / 2048) / 2 });
  });

  test('pillarboxed: a phone clip in a 16:9 stage has bars at the sides', () => {
    close(containRect(1600, 900, 1080, 1920), { y: 0, height: 900, width: 900 * 1080 / 1920, x: (1600 - 900 * 1080 / 1920) / 2 });
  });

  test('fullscreen and a resize move the rectangle, never the point on the picture', () => {
    // The same source point, mapped through two stage sizes and back.
    for (const [bw, bh] of [[968, 544], [1920, 1080], [2560, 1080], [375, 667]]) {
      const r = containRect(bw, bh, 3840, 2160);
      const [x, y] = [0.41, 0.22];
      const clientX = r.x + x * r.width;
      const clientY = r.y + y * r.height;
      const back = pointOnPicture(clientX, clientY, { left: r.x, top: r.y, width: r.width, height: r.height });
      assert.deepEqual(back, [x, y], `${bw}x${bh}`);
    }
  });

  test('an unknown picture size falls back to the whole stage', () => {
    close(containRect(800, 450, 0, 0), { x: 0, y: 0, width: 800, height: 450 });
    close(containRect(0, 0, 100, 100), { x: 0, y: 0, width: 0, height: 0 });
  });

  test('a pointer outside the picture is held to its edge', () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 };
    assert.deepEqual(pointOnPicture(50, 20, rect), [0, 0]);
    assert.deepEqual(pointOnPicture(900, 900, rect), [1, 1]);
    assert.deepEqual(pointOnPicture(300, 150, rect), [0.5, 0.5]);
  });
});

test('snippets and reviewer keys', () => {
  assert.equal(snippet('  a\n\n b  '), 'a b');
  assert.equal(snippet('x'.repeat(200), 10).length, 10);
  assert.equal(userReviewer(' Me@X.io '), 'user:me@x.io');
});
