// lib/hdr-tonemap.js — an HDR frame (HLG or PQ, BT.2020) taken to SDR
// (BT.709, sRGB-encoded) on the GPU, from the frame's own Y'CbCr planes,
// turned upright and scaled to the copy's size on the way.
//
// For a browser whose decoder hands back an HDR video's frames without
// saying they are HDR: WebKit (Safari, Onyx for Mac's web view) decodes an
// iPhone's 10-bit HLG clip to 8-bit NV12 labelled sRGB, so a canvas it is
// drawn onto takes the HLG signal for SDR and the copy comes out washed out
// — grey blacks, faded colour. Chrome labels them truly and its canvas tone-
// maps them itself (lib/video-convert.js uses that where it can); this is
// for where it cannot. The track's own colour information (from the file)
// says what the frames are.
//
// The conversion, per pixel (ITU-R BT.2100, BT.2408):
//
//   Y'CbCr (limited range) → R'G'B' by the BT.2020 matrix
//   → light: HLG through its inverse OETF and the OOTF of a 1000-nit display
//     (γ 1.2), PQ through its EOTF — in nits either way
//   → relative to HDR reference white, 203 nits, which becomes SDR's white
//   → BT.2020 primaries to BT.709 (negatives clipped)
//   → highlights past 80% rolled off smoothly to 100% (on the brightest
//     channel, so hues hold) rather than clipped
//   → the sRGB curve, as a canvas holds its colours
//
// Read back through pixel-pack buffers, a few frames in flight: WebKit's
// readPixels into memory (or a VideoFrame made from the WebGL canvas) waits
// for the GPU every time — 41 ms a 1080p frame, measured — where a fenced
// buffer read a few frames behind costs 5. So frames go in (`submit`) and
// come out (`next`) a few apart, as RGBX buffers for a VideoFrame.
//
// WebGL 2 on an OffscreenCanvas: in a worker where the browser has one, or
// on the page's.

const VERTEX = `#version 300 es
in vec2 corner;
out vec2 at;
void main() {
  // Rows come back from readPixels bottom first: drawn upside down here, so
  // the buffer holds the picture top first.
  at = vec2((corner.x + 1.0) * 0.5, (corner.y + 1.0) * 0.5);
  gl_Position = vec4(corner, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D lumaPlane;
uniform sampler2D chromaPlane;
uniform sampler2D crPlane;
uniform int planar;
uniform int pq;
uniform int rotation;
uniform int flip;
in vec2 at;
out vec4 colour;

float hlgToScene(float e) {
  const float a = 0.17883277;
  const float b = 0.28466892;
  const float c = 0.55991073;
  return e <= 0.5 ? e * e / 3.0 : (exp((e - c) / a) + b) / 12.0;
}

float pqToNits(float e) {
  const float m1 = 0.1593017578125;
  const float m2 = 78.84375;
  const float c1 = 0.8359375;
  const float c2 = 18.8515625;
  const float c3 = 18.6875;
  float p = pow(max(e, 0.0), 1.0 / m2);
  return 10000.0 * pow(max(p - c1, 0.0) / (c2 - c3 * p), 1.0 / m1);
}

float srgb(float v) {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

void main() {
  // Where in the stored frame this point of the upright picture is.
  vec2 p = at;
  if (flip == 1) p.x = 1.0 - p.x;
  vec2 src = rotation == 90 ? vec2(p.y, 1.0 - p.x) : rotation == 180 ? vec2(1.0 - p.x, 1.0 - p.y) : rotation == 270 ? vec2(1.0 - p.y, p.x) : p;

  float y = texture(lumaPlane, src).r;
  vec2 c = planar == 1 ? vec2(texture(chromaPlane, src).r, texture(crPlane, src).r) : texture(chromaPlane, src).rg;
  float Y = (y * 255.0 - 16.0) / 219.0;
  float Cb = (c.x * 255.0 - 128.0) / 224.0;
  float Cr = (c.y * 255.0 - 128.0) / 224.0;
  vec3 e = clamp(vec3(Y + 1.4746 * Cr, 0.0, Y + 1.8814 * Cb), 0.0, 1.0);
  e.g = clamp((Y - 0.2627 * e.r - 0.0593 * e.b) / 0.6780, 0.0, 1.0);

  vec3 nits;
  if (pq == 1) {
    nits = vec3(pqToNits(e.r), pqToNits(e.g), pqToNits(e.b));
  } else {
    vec3 scene = vec3(hlgToScene(e.r), hlgToScene(e.g), hlgToScene(e.b));
    float ys = dot(scene, vec3(0.2627, 0.6780, 0.0593));
    nits = 1000.0 * pow(max(ys, 1e-6), 0.2) * scene;
  }
  vec3 rel = nits / 203.0;
  vec3 rgb = max(mat3(
    1.6605, -0.1246, -0.0182,
    -0.5876, 1.1329, -0.1006,
    -0.0728, -0.0083, 1.1187
  ) * rel, 0.0);

  float peak = max(max(rgb.r, rgb.g), rgb.b);
  const float knee = 0.8;
  if (peak > knee) {
    float over = (peak - knee) / (1.0 - knee);
    float rolled = knee + (1.0 - knee) * (1.0 - exp(-over));
    rgb *= rolled / peak;
  }
  colour = vec4(srgb(rgb.r), srgb(rgb.g), srgb(rgb.b), 1.0);
}`;

/** Whether an HDR frame's planes can be taken to SDR here: WebGL 2 on an OffscreenCanvas. */
export function canToneMap() {
  try {
    return typeof OffscreenCanvas === 'function' && !!new OffscreenCanvas(2, 2).getContext('webgl2');
  } catch {
    return false;
  }
}

const PLANE_FORMATS = new Set(['NV12', 'I420']);

/** Whether this is a frame whose planes toneMapper reads: 8-bit NV12 or I420. */
export const toneMappable = (format) => PLANE_FORMATS.has(format);

/** What the RGBX frames that come out are: sRGB, as a canvas's would be. */
export const TONE_MAPPED_COLOUR = Object.freeze({ primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true });

/**
 * A tone mapper making frames of `width` × `height` — the copy's size,
 * upright — from frames stored at their own size, turned by `rotation`
 * (0, 90, 180, 270, clockwise) and `flip`, whose transfer is `transfer`
 * ('hlg' or 'pq'). `submit(frame, meta)` sends a VideoFrame's planes up and
 * converts them; `next()` resolves the oldest submitted as { data, meta },
 * `data` its RGBX bytes (top row first) — valid until `depth` more have come
 * out. `pending` is how many are on their way. `close()` lets the GPU's
 * memory go.
 */
export function toneMapper(width, height, { transfer, rotation = 0, flip = false, depth = 3 } = {}) {
  const canvas = new OffscreenCanvas(width, height);
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
  if (!gl) throw new Error('No WebGL 2 here to take HDR to SDR.');
  const compile = (type, source) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Tone mapping did not compile: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Tone mapping did not link: ${gl.getProgramInfoLog(program)}`);
  gl.useProgram(program);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, 'corner');
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

  // Mipmapped, so a frame shrunk more than twice over is averaged, not sampled.
  const texture = (unit, name) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, name), unit);
    return t;
  };
  const luma = texture(0, 'lumaPlane');
  const chroma = texture(1, 'chromaPlane');
  const cr = texture(2, 'crPlane');
  gl.uniform1i(gl.getUniformLocation(program, 'pq'), transfer === 'pq' ? 1 : 0);
  gl.uniform1i(gl.getUniformLocation(program, 'rotation'), [0, 90, 180, 270].includes(rotation) ? rotation : 0);
  gl.uniform1i(gl.getUniformLocation(program, 'flip'), flip ? 1 : 0);
  const planarAt = gl.getUniformLocation(program, 'planar');
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  gl.viewport(0, 0, width, height);

  let planes = null;
  const upload = (unit, tex, internal, format, w, h, offset, stride, bytesPerPixel) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride / bytesPerPixel);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.UNSIGNED_BYTE, planes, offset);
    gl.generateMipmap(gl.TEXTURE_2D);
  };

  const bytes = width * height * 4;
  const free = [];
  const outs = [];
  const flights = [];
  let shelf = 0;

  return {
    get pending() { return flights.length; },

    async submit(frame, meta) {
      if (!toneMappable(frame.format)) throw new Error(`Frames in ${frame.format || 'an unknown format'} cannot be taken to SDR here.`);
      // The picture only: a decoder's frame is often coded taller (1088 for 1080).
      const rect = frame.visibleRect || { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
      const options = { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      const size = frame.allocationSize(options);
      if (!planes || planes.byteLength < size) planes = new Uint8Array(size);
      const layout = await frame.copyTo(planes, options);
      const w = rect.width;
      const h = rect.height;
      const cw = Math.ceil(w / 2);
      const ch = Math.ceil(h / 2);
      upload(0, luma, gl.R8, gl.RED, w, h, layout[0].offset, layout[0].stride, 1);
      if (frame.format === 'NV12') {
        upload(1, chroma, gl.RG8, gl.RG, cw, ch, layout[1].offset, layout[1].stride, 2);
        gl.uniform1i(planarAt, 0);
      } else {
        upload(1, chroma, gl.R8, gl.RED, cw, ch, layout[1].offset, layout[1].stride, 1);
        upload(2, cr, gl.R8, gl.RED, cw, ch, layout[2].offset, layout[2].stride, 1);
        gl.uniform1i(planarAt, 1);
      }
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      let pbo = free.pop();
      if (!pbo) {
        pbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      flights.push({ pbo, sync, meta });
    },

    async next() {
      const flight = flights.shift();
      if (!flight) return null;
      for (;;) {
        const state = gl.clientWaitSync(flight.sync, 0, 0);
        if (state === gl.ALREADY_SIGNALED || state === gl.CONDITION_SATISFIED) break;
        if (state === gl.WAIT_FAILED) throw new Error('The GPU stopped answering.');
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      gl.deleteSync(flight.sync);
      // Buffers taken round in turn: one is written over only `depth` frames later.
      const data = outs[shelf] || (outs[shelf] = new Uint8Array(bytes));
      shelf = (shelf + 1) % (depth + 1);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, flight.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      free.push(flight.pbo);
      return { data, meta: flight.meta };
    },

    close() {
      for (const f of flights) gl.deleteSync(f.sync);
      flights.length = 0;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      planes = null;
      outs.length = 0;
    },
  };
}
