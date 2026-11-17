import { useEffect, useRef, useState } from "react";

/*
  The start page's picture: a small 3D farm that turns slowly and changes every four and a half seconds
  (scene/spinFarms.ts). Decoration, so it is hidden from screen readers and takes no clicks.

  The 3D code is fetched only after the page is up, and only where the browser can draw 3D;
  anywhere else nothing is shown and the button stands alone, as before. People who ask their
  device for less motion get one farm, standing still.
*/
export const canDraw3d = (): boolean => typeof window !== "undefined" && typeof window.WebGLRenderingContext !== "undefined";

export function FarmSpin() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [on, setOn] = useState(false);
  const [failed, setFailed] = useState(false);
  const able = canDraw3d();

  useEffect(() => {
    const el = canvas.current;
    if (!el || !able) return;
    let stop: (() => void) | undefined;
    let gone = false;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    import("../../scene/spinFarms")
      .then((m) => {
        if (gone) return;
        stop = m.startFarmScene(el, { still });
        setOn(true);
      })
      .catch(() => {
        // No 3D after all (the graphics card said no, or the file did not arrive): give the space back.
        if (!gone) setFailed(true);
      });
    return () => {
      gone = true;
      stop?.();
    };
  }, [able]);

  if (!able || failed) return null;
  return (
    <div className="dh-farm" data-on={on ? "yes" : "no"} aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}
