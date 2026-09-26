'use client';

import { memo, useState } from 'react';
import Menu, { MenuItem, MenuSeparator } from '@/app/components/ui/Menu';
import MentionTextarea, { mentionsIn } from './MentionTextarea';
import { ago, handleOf, initials, personLabel } from './format';

/**
 * One thread: a comment, its replies, and what the reader may do with it.
 *
 * The controls offered follow the server's rules (reviewDecision in
 * lib/review.js) so nothing is offered that would only earn a 403: the
 * author edits; the author or anyone who may change the file deletes and
 * resolves. The server checks again either way.
 *
 * Clicking the comment (or its timecode) selects it, which is how the page
 * seeks the player to its frame and shows its drawing.
 */
function CommentThread({
  comment, replies = [], me, canModify, anchor, pinNumber = null, selected = false, unread = false,
  unreadIds, fileId, onSelect, onReply, onUpdate, onRemove, onError,
}) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const [people, setPeople] = useState([]);
  const resolved = !!comment.resolvedAt;

  const sendReply = async () => {
    const body = text.trim();
    if (!body) return;
    const saved = { text, people };
    setText('');
    setPeople([]);
    setReplying(false);
    try {
      await onReply({ body, parentId: comment.id, mentions: mentionsIn(body, people) });
    } catch (e) {
      setText(saved.text);
      setPeople(saved.people);
      setReplying(true);
      onError?.(e);
    }
  };

  return (
    <article
      className={`review-thread${selected ? ' is-selected' : ''}${resolved ? ' is-resolved' : ''}${comment.pending ? ' is-pending' : ''}`}
      aria-current={selected || undefined}
    >
      <CommentBody
        c={comment}
        me={me}
        canModify={canModify}
        anchor={anchor}
        pinNumber={pinNumber}
        unread={unread}
        onSelect={() => onSelect?.(comment)}
        onUpdate={onUpdate}
        onRemove={onRemove}
        onError={onError}
        fileId={fileId}
        extra={!comment.deletedAt && (isMine(comment, me) || canModify) && !comment.pending && (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => onUpdate(comment.id, { resolved: !resolved }).catch(onError)}>
              {resolved ? 'Reopen' : 'Resolve'}
            </MenuItem>
          </>
        )}
      />

      {replies.length > 0 && (
        <div className="review-replies">
          {replies.map((r) => (
            <CommentBody
              key={r.id}
              c={r}
              me={me}
              canModify={canModify}
              unread={unreadIds?.has(r.id)}
              onSelect={() => onSelect?.(comment)}
              onUpdate={onUpdate}
              onRemove={onRemove}
              onError={onError}
              fileId={fileId}
              reply
            />
          ))}
        </div>
      )}

      {!comment.pending && (replying ? (
        <div className="review-reply-box">
          <MentionTextarea
            fileId={fileId}
            value={text}
            onChange={setText}
            people={people}
            onPeopleChange={setPeople}
            onSubmit={sendReply}
            onEscape={() => setReplying(false)}
            placeholder="Reply…"
            label="Reply"
            rows={2}
          />
          <div className="review-composer-row">
            <div className="spacer" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReplying(false)}>Cancel</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={sendReply} disabled={!text.trim()}>Reply</button>
          </div>
        </div>
      ) : (
        <div className="review-thread-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReplying(true)}>Reply</button>
          {resolved && <span className="small muted">Resolved{comment.resolvedBy ? ` by ${handleOf(comment.resolvedBy)}` : ''}</span>}
        </div>
      ))}
    </article>
  );
}

export default memo(CommentThread);

const isMine = (c, me) => !!me && c.author?.email === me;

function CommentBody({ c, me, canModify, anchor, pinNumber, unread, onSelect, onUpdate, onRemove, onError, fileId, extra = null, reply = false }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.body);
  const [people, setPeople] = useState([]);
  const mine = isMine(c, me);

  if (c.deletedAt) {
    return (
      <div className={`review-comment${reply ? ' is-reply' : ''}`}>
        <p className="review-body small muted"><em>Comment deleted</em></p>
      </div>
    );
  }

  const save = async () => {
    const body = text.trim();
    if (!body && !c.annotation) return;
    try {
      // Mentions already in the comment survive an edit as long as their
      // handle is still in the text.
      const known = [...(c.mentions || []).map((email) => ({ email })), ...people];
      await onUpdate(c.id, { body, mentions: mentionsIn(body, known) });
      setEditing(false);
    } catch (e) {
      onError?.(e);
    }
  };

  return (
    <div className={`review-comment${reply ? ' is-reply' : ''}`}>
      <div className="review-comment-head">
        <span className="review-avatar" aria-hidden="true">{initials(c.author)}</span>
        <span className="review-author small truncate" title={c.author?.email || undefined}>
          {personLabel(c.author)}{c.author?.guest ? <span className="muted"> · Guest</span> : null}
        </span>
        <span className="small muted" title={c.createdAt ? new Date(c.createdAt).toLocaleString() : undefined}>
          {c.pending ? 'Posting…' : ago(c.createdAt)}
        </span>
        {c.audience === 'internal' && <span className="tag review-internal-tag" title="Signed-in people only">Internal</span>}
        {unread && <span className="review-unread" aria-label="New" />}
        <div className="spacer" />
        {!c.pending && (mine || canModify) && (
          <Menu label="Comment actions">
            {mine && <MenuItem onClick={() => { setText(c.body); setEditing(true); }}>Edit</MenuItem>}
            <MenuItem danger onClick={() => onRemove(c.id).catch(onError)}>Delete</MenuItem>
            {extra}
          </Menu>
        )}
      </div>

      {!reply && (anchor || pinNumber != null) && (
        <button type="button" className="review-anchor mono" onClick={onSelect} title="Show this moment">
          {pinNumber != null ? `Pin ${pinNumber}` : anchor}
        </button>
      )}

      {editing ? (
        <div className="review-reply-box">
          <MentionTextarea
            fileId={fileId}
            value={text}
            onChange={setText}
            people={people}
            onPeopleChange={setPeople}
            onSubmit={save}
            onEscape={() => setEditing(false)}
            label="Edit comment"
            rows={2}
          />
          <div className="review-composer-row">
            <div className="spacer" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={save}>Save</button>
          </div>
        </div>
      ) : (
        // The body selects the thread too, so a long comment is a big target.
        <div className="review-body small" onClick={onSelect}>
          {c.body ? <Body text={c.body} mentions={c.mentions} /> : null}
          {c.annotation && <span className="review-drawn muted"> ✎ Drawing</span>}
          {c.editedAt && <span className="muted"> (edited)</span>}
        </div>
      )}
    </div>
  );
}

/** The words, with the @handles of people actually mentioned picked out. */
function Body({ text, mentions = [] }) {
  const handles = new Set(mentions.map((m) => handleOf(m).toLowerCase()));
  const parts = String(text).split(/(@[^\s@]+)/g);
  return parts.map((p, i) => {
    const h = p.startsWith('@') ? p.slice(1).replace(/[.,;:!?)]+$/, '').toLowerCase() : null;
    return h && handles.has(h) ? <span key={i} className="review-mention">{p}</span> : <span key={i}>{p}</span>;
  });
}
