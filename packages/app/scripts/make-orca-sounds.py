#!/usr/bin/env python3
"""
OrcaCoder's calm sound set: the same 18 sounds as `make-sounds.py`, made quiet,
short and conventional — soft ticks, a gentle chime, a polite knock — because
the bright FM bells came across as dings on a phone speaker.

    python packages/app/scripts/make-orca-sounds.py [out_dir]

Writes `<out_dir>/<name>.wav` (mono, 44.1 kHz, 16-bit), default
`packages/app/assets/sounds`. Same names and the same `charge` length as
`make-sounds.py`, so nothing in the app changes but the sound. Synthesised
from sine tones only (no samples, nothing licensed). Needs numpy and scipy.
Deterministic: the same script writes the same files.
"""
import os
import sys

import numpy as np
from scipy.io import wavfile

SR = 44100
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "assets", "sounds"
)

# Must match GoalLaunchPad.tsx (HOLD_MS) and launchFx.ts (RING_DOTS).
HOLD_S = 1.6
RING_DOTS = 24


def db(level: float) -> float:
    return 10 ** (level / 20)


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(SR * seconds))


def tone(freq: float, seconds: float, decay: float = 8.0, attack: float = 0.006, warmth: float = 0.15) -> np.ndarray:
    """A soft sine with a short fade-in and an exponential fade-out."""
    t = np.arange(int(SR * seconds)) / SR
    wave = np.sin(2 * np.pi * freq * t) + warmth * np.sin(2 * np.pi * 2 * freq * t)
    envelope = np.minimum(1, t / attack) * np.exp(-decay * t)
    return wave * envelope


def at(track: np.ndarray, sound: np.ndarray, start: float) -> np.ndarray:
    i = int(SR * start)
    end = i + len(sound)
    if end > len(track):
        track = np.concatenate([track, silence((end - len(track)) / SR)])
    track[i:end] += sound
    return track


def finish(sound: np.ndarray, peak_db: float) -> np.ndarray:
    """Normalise to a quiet peak, with a 5 ms fade at the end so nothing clicks."""
    sound = sound / (np.max(np.abs(sound)) or 1) * db(peak_db)
    fade = min(len(sound), int(SR * 0.005))
    sound[-fade:] *= np.linspace(1, 0, fade)
    return sound


def write(name: str, sound: np.ndarray) -> None:
    os.makedirs(OUT, exist_ok=True)
    wavfile.write(os.path.join(OUT, f"{name}.wav"), SR, (sound * 32767).astype(np.int16))


C5, E5, G5, A5, C6 = 523.25, 659.25, 783.99, 880.0, 1046.5

# You sent a message: a single soft tick.
write("send", finish(tone(1320, 0.09, decay=55, warmth=0.05), -24))

# An agent finished: a gentle two-note chime, rising.
done = at(at(silence(0.6), tone(E5, 0.45, decay=9), 0), tone(A5, 0.45, decay=9), 0.13)
write("done", finish(done, -18))

# An agent needs you: two polite knocks on the same note.
knock = tone(C5, 0.12, decay=30, warmth=0.3)
write("attention", finish(at(at(silence(0.35), knock, 0), knock, 0.16), -17))

# The thinking dial: barely-there clicks, a little higher for each stop up.
for i in range(5):
    write(f"level-up-{i}", finish(tone(700 + 110 * i, 0.05, decay=80, warmth=0.05), -28))
    write(f"level-down-{i}", finish(tone(640 + 90 * i, 0.05, decay=80, warmth=0.05), -30))
write("level-max", finish(at(at(silence(0.16), tone(1250, 0.05, decay=80), 0), tone(1500, 0.06, decay=70), 0.07), -25))

# Launching a Goal. `charge` keeps its length (the hold) with a faint tick per
# ring dot over a quiet rising hum; the rest are small, soft cues.
charge = silence(HOLD_S)
t = np.arange(len(charge)) / SR
charge += 0.25 * np.sin(2 * np.pi * (220 + 110 * t / HOLD_S) * t) * np.minimum(1, t / 0.2)
for dot in range(RING_DOTS):
    charge = at(charge, 0.6 * tone(900 + 12 * dot, 0.03, decay=90, warmth=0), HOLD_S * dot / RING_DOTS)
write("charge", finish(charge[: int(SR * HOLD_S)], -27))
write("drain", finish(tone(392, 0.22, decay=16), -27))
write("burst", finish(at(at(at(silence(0.8), tone(C5, 0.7, decay=6), 0), tone(E5, 0.7, decay=6), 0.02), tone(G5, 0.7, decay=6), 0.04), -20))
write("reveal", finish(at(at(at(silence(0.75), tone(G5, 0.4, decay=10), 0), tone(C6, 0.4, decay=10), 0.12), tone(E5 * 2, 0.4, decay=10), 0.24), -21))

print(f"wrote 18 sounds to {os.path.abspath(OUT)}")
