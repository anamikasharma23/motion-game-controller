import { useEffect, useRef } from 'react';
import { DeviceMotion, type DeviceMotionMeasurement } from 'expo-sensors';
import { DEADZONE, MAX_TILT_RAD, SEND_INTERVAL_MS, SHAKE_COOLDOWN_MS, SHAKE_THRESHOLD } from './config';

export type Tilt = { x: number; y: number };

type Options = {
  /** called every sensor tick with calibrated tilt in -1..1 and whether a shake fired */
  onSample: (tilt: Tilt, shake: boolean) => void;
  invertX: boolean;
  invertY: boolean;
};

const clamp = (v: number) => Math.max(-1, Math.min(1, v));

// Map raw angle delta to -1..1 with a deadzone, so holding "level" really reads 0.
function shape(delta: number) {
  const v = clamp(delta / MAX_TILT_RAD);
  const a = Math.abs(v);
  if (a < DEADZONE) return 0;
  return Math.sign(v) * ((a - DEADZONE) / (1 - DEADZONE));
}

/**
 * Uses DeviceMotion's fused rotation (gyro + accelerometer + magnetometer,
 * combined by the OS) for tilt, so there's no gyro drift to fight. Raw linear
 * acceleration is used only for shake detection.
 */
export function useMotion({ onSample, invertX, invertY }: Options) {
  const neutral = useRef({ beta: 0, gamma: 0 });
  const latest = useRef({ beta: 0, gamma: 0 });
  const lastShake = useRef(0);
  const steady = useRef<Tilt>({ x: 0, y: 0 });
  const cb = useRef(onSample);
  cb.current = onSample;
  const inv = useRef({ invertX, invertY });
  inv.current = { invertX, invertY };

  useEffect(() => {
    DeviceMotion.setUpdateInterval(SEND_INTERVAL_MS);
    const sub = DeviceMotion.addListener((m: DeviceMotionMeasurement) => {
      const { beta, gamma } = m.rotation;
      latest.current = { beta, gamma };

      // beta: front/back pitch (top edge up = positive) -> ball rolls toward you (+y)
      // gamma: left/right roll (right edge down = positive) -> ball rolls right (+x)
      let x = shape(gamma - neutral.current.gamma);
      let y = shape(beta - neutral.current.beta);
      if (inv.current.invertX) x = -x;
      if (inv.current.invertY) y = -y;

      // Shake = a spike in linear acceleration. Some devices don't give gravity-free
      // acceleration, so fall back to |a with gravity| minus 1g.
      let mag: number;
      if (m.acceleration) {
        const a = m.acceleration;
        mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
      } else {
        const a = m.accelerationIncludingGravity;
        mag = Math.abs(Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) - 9.81);
      }
      const now = Date.now();
      let shake = false;
      if (mag > SHAKE_THRESHOLD && now - lastShake.current > SHAKE_COOLDOWN_MS) {
        lastShake.current = now;
        shake = true;
      }

      // While the phone is being jolted, the angle reading is junk. Hold the
      // last steady tilt so a shake-to-jump doesn't also fling the ball sideways.
      if (mag > SHAKE_THRESHOLD * 0.5 || now - lastShake.current < 200) {
        x = steady.current.x;
        y = steady.current.y;
      } else {
        steady.current = { x, y };
      }

      cb.current({ x, y }, shake);
    });
    return () => sub.remove();
  }, []);

  /** Whatever angle the phone is held at right now becomes "level". */
  const calibrate = () => {
    neutral.current = { ...latest.current };
  };

  return { calibrate };
}
