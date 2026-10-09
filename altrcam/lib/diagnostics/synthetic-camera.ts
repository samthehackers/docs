/**
 * Browser-only. A fake webcam for the realtime check: an animated <canvas> (a simple head-and-shoulders figure, moving
 * shapes and a frame counter) captured with canvas.captureStream(). No real camera or permission is needed, so the
 * check runs the same way in a headless browser.
 */
export const SYNTHETIC_CAMERA = { width: 640, height: 360, fps: 30 } as const;

export interface SyntheticCamera {
  stream: MediaStream;
  stop: () => void;
}

export function startSyntheticCamera(canvas: HTMLCanvasElement): SyntheticCamera {
  const { width: w, height: h, fps } = SYNTHETIC_CAMERA;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot draw the synthetic camera (no 2D canvas)");
  if (typeof canvas.captureStream !== "function") throw new Error("This browser cannot capture a canvas as video (no canvas.captureStream)");
  let frame = 0;

  const draw = () => {
    const t = frame / fps;
    const hue = (t * 20) % 360;
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, `hsl(${hue}, 45%, 35%)`);
    bg.addColorStop(1, `hsl(${(hue + 60) % 360}, 45%, 20%)`);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    // A moving bar and ball, so every frame differs.
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.fillRect(((t * 120) % (w + 80)) - 80, 0, 40, h);
    ctx.fillStyle = "hsl(45, 90%, 60%)";
    ctx.beginPath();
    ctx.arc(w * 0.85, h * 0.25 + Math.sin(t * 2) * 30, 18, 0, Math.PI * 2);
    ctx.fill();
    // A head-and-shoulders figure, swaying a little, for the model to restyle.
    const cx = w / 2 + Math.sin(t) * 25;
    ctx.fillStyle = "hsl(25, 45%, 70%)";
    ctx.beginPath();
    ctx.ellipse(cx, h * 0.42, 52, 64, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "hsl(210, 40%, 45%)";
    ctx.beginPath();
    ctx.ellipse(cx, h * 0.98, 130, 90, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = "#1b1b1b";
    for (const dx of [-18, 18]) { ctx.beginPath(); ctx.arc(cx + dx, h * 0.39, 6, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillRect(cx - 14, h * 0.5, 28, 4);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "14px monospace";
    ctx.fillText(`AltrCam diagnostics · synthetic camera · frame ${frame}`, 12, 22);
    frame++;
  };

  draw();
  // A timer rather than requestAnimationFrame: rAF stops in a hidden tab, and the check should keep sending frames.
  const timer = setInterval(draw, 1000 / fps);
  const stream = canvas.captureStream(fps);
  return {
    stream,
    stop: () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}
