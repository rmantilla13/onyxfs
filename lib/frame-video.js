/**
 * A <video> to draw frames from, and nothing else.
 *
 * WebKit — Safari, and the Mac app's web view — only paints a video that is
 * in the document and rendered: from a detached element, or one moved off
 * screen or hidden, every frame draws as transparent. So the element sits in
 * the page, a pixel wide, fully transparent and out of the way, until
 * `cleanup` takes it out again. (Chrome and Firefox draw either way.)
 */
export function frameVideo(cleanup) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('aria-hidden', 'true');
  v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(v);
  cleanup.push(() => { v.removeAttribute('src'); v.load(); v.remove(); });
  return v;
}
