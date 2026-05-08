import argparse
import csv
import os
import platform
import sys
import time
from collections import OrderedDict

import cv2
import numpy as np

from make_report import write_report


# ── Platform-specific arrow key codes (cv2.waitKeyEx) ─────────────────────────
_SYS = platform.system()
if _SYS == "Darwin":
    KEY_LEFT, KEY_RIGHT, KEY_UP, KEY_DOWN = 63234, 63235, 63232, 63233
elif _SYS == "Linux":
    KEY_LEFT, KEY_RIGHT, KEY_UP, KEY_DOWN = 65361, 65363, 65362, 65364
else:
    KEY_LEFT, KEY_RIGHT, KEY_UP, KEY_DOWN = 2424832, 2555904, 2490368, 2621440

KEY_ENTER = 13
KEY_ESC   = 27
KEY_SPACE = 32

MAX_DISP_W, MAX_DISP_H = 1280, 720
AXIS_LEN = 40   # pixels for axis arrows drawn on output frames


def _disp_size(fw, fh):
    s = min(MAX_DISP_W / fw, MAX_DISP_H / fh, 1.0)
    return int(fw * s), int(fh * s)


# ── Video loading ──────────────────────────────────────────────────────────────

def load_video(path):
    if not os.path.exists(path):
        print(f"Error: file not found: {path}")
        sys.exit(1)
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        print(f"Error: could not open: {path}")
        sys.exit(1)
    n   = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    fw  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    fh  = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if n == 0:
        print("Error: video has zero frames.")
        sys.exit(1)
    print(f"{os.path.basename(path)}  {fw}x{fh}  {n} frames  {fps:.1f}fps")
    return cap, fps, fw, fh, n


# ── Frame cache (LRU, memory-bounded) ─────────────────────────────────────────

class FrameCache:
    def __init__(self, cap, max_size=60):
        self._cap = cap
        self._max = max_size
        self._d   = OrderedDict()

    def get(self, idx):
        if idx in self._d:
            self._d.move_to_end(idx)
            return self._d[idx]
        self._cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = self._cap.read()
        if not ret:
            return None
        if len(self._d) >= self._max:
            self._d.popitem(last=False)
        self._d[idx] = frame
        return frame


# ── Axes overlay ───────────────────────────────────────────────────────────────

def _draw_axes(frame, ox, oy):
    """Draw a small XY axis indicator at (ox, oy) in pixel space."""
    ox, oy = int(ox), int(oy)
    # X axis → right (positive x)
    cv2.arrowedLine(frame, (ox, oy), (ox + AXIS_LEN, oy), (0, 220, 220), 2, tipLength=0.25)
    cv2.putText(frame, "X", (ox + AXIS_LEN + 4, oy + 5),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 220, 220), 1)
    # Y axis ↑ up (positive y, image Y is flipped)
    cv2.arrowedLine(frame, (ox, oy), (ox, oy - AXIS_LEN), (0, 220, 220), 2, tipLength=0.25)
    cv2.putText(frame, "Y", (ox + 4, oy - AXIS_LEN - 4),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 220, 220), 1)
    # origin dot
    cv2.circle(frame, (ox, oy), 3, (0, 220, 220), -1)


# ── Interactive frame selector + zoomed bbox / origin drawer ──────────────────

class InteractiveSelector:
    """
    Phase 1 — navigate()   : scrub frames; zoom/pan; ENTER to confirm.
    Phase 2 — set_origin() : click to place coordinate origin (0,0); ENTER to confirm.
    Phase 3 — draw_bbox()  : click-drag to draw bounding box; ENTER to confirm.
    """

    def __init__(self, cap, total_frames, fps, fw, fh):
        self._cache       = FrameCache(cap, max_size=60)
        self.total_frames = total_frames
        self.fps          = fps
        self.fw, self.fh  = fw, fh
        self.dw, self.dh  = _disp_size(fw, fh)

        self.frame_idx = 0
        self.zoom      = 1.0
        self.pan_x     = 0.0
        self.pan_y     = 0.0

        # phase-1 pan drag state
        self._panning    = False
        self._pan_origin = None
        self._pan_start  = (0.0, 0.0)

        # phase-2 origin state
        self._origin_disp = None   # display-space confirmed click position
        self._cursor_disp = None   # display-space live cursor position

        # phase-3 scale state
        self._sp1     = None   # first scale point (display coords)
        self._sp2     = None   # second scale point (display coords)
        self._scursor = None   # live cursor while drawing scale line
        self._sinput  = ""     # typed meters string
        self._sphase  = "line" # "line" | "text"

        # phase-4 rect draw state
        self._p1 = self._p2 = None
        self._drawing = False

    # ── Internal helpers ──────────────────────────────────────────────────

    def _clamp_pan(self):
        vw = self.fw / self.zoom
        vh = self.fh / self.zoom
        self.pan_x = max(0.0, min(self.pan_x, self.fw - vw))
        self.pan_y = max(0.0, min(self.pan_y, self.fh - vh))

    def _zoom_at(self, dx, dy, factor):
        ox, oy = self._d2o(dx, dy)
        self.zoom  = max(1.0, min(self.zoom * factor, 30.0))
        vw = self.fw / self.zoom
        vh = self.fh / self.zoom
        self.pan_x = ox - dx / self.dw * vw
        self.pan_y = oy - dy / self.dh * vh
        self._clamp_pan()

    def _pan_by(self, dpx, dpy):
        vw = self.fw / self.zoom
        vh = self.fh / self.zoom
        self.pan_x += dpx / self.dw * vw
        self.pan_y += dpy / self.dh * vh
        self._clamp_pan()

    def _d2o(self, dx, dy):
        """Display pixel → original-frame pixel (float)."""
        vw = self.fw / self.zoom
        vh = self.fh / self.zoom
        return self.pan_x + dx / self.dw * vw, self.pan_y + dy / self.dh * vh

    def _render(self, frame, hint="", overlay_fn=None):
        vw = self.fw / self.zoom
        vh = self.fh / self.zoom
        x1, y1 = int(self.pan_x), int(self.pan_y)
        x2 = int(min(self.pan_x + vw, self.fw))
        y2 = int(min(self.pan_y + vh, self.fh))
        crop = frame[y1:y2, x1:x2].copy()
        disp = cv2.resize(crop, (self.dw, self.dh), interpolation=cv2.INTER_LINEAR)
        if overlay_fn:
            overlay_fn(disp)
        info = (f"Frame {self.frame_idx}/{self.total_frames-1}  "
                f"zoom {self.zoom:.1f}x  |  {hint}")
        cv2.putText(disp, info, (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 220, 220), 2)
        return disp

    def _zoom_pan_keys(self, key):
        """Handle shared zoom/pan keys. Returns True if key was consumed."""
        STEP = 80
        if   key in (ord("+"), ord("=")): self._zoom_at(self.dw // 2, self.dh // 2, 1.25)
        elif key == ord("-"):             self._zoom_at(self.dw // 2, self.dh // 2, 1 / 1.25)
        elif key == ord("i"):             self._pan_by(0, -STEP)
        elif key == ord("k"):             self._pan_by(0,  STEP)
        elif key == ord("j"):             self._pan_by(-STEP, 0)
        elif key == ord("l"):             self._pan_by( STEP, 0)
        else: return False
        return True

    # ── Mouse callbacks ───────────────────────────────────────────────────

    def _cb_nav(self, event, x, y, flags, _):
        if event == cv2.EVENT_MOUSEWHEEL:
            self._zoom_at(x, y, 1.15 if flags > 0 else 1 / 1.15)
        elif event == cv2.EVENT_LBUTTONDOWN:
            self._panning    = True
            self._pan_origin = (x, y)
            self._pan_start  = (self.pan_x, self.pan_y)
        elif event == cv2.EVENT_MOUSEMOVE and self._panning:
            vw = self.fw / self.zoom
            vh = self.fh / self.zoom
            self.pan_x = self._pan_start[0] - (x - self._pan_origin[0]) / self.dw * vw
            self.pan_y = self._pan_start[1] - (y - self._pan_origin[1]) / self.dh * vh
            self._clamp_pan()
        elif event == cv2.EVENT_LBUTTONUP:
            self._panning = False

    def _cb_origin(self, event, x, y, flags, _):
        if event == cv2.EVENT_MOUSEWHEEL:
            self._zoom_at(x, y, 1.15 if flags > 0 else 1 / 1.15)
        elif event == cv2.EVENT_MOUSEMOVE:
            self._cursor_disp = (x, y)
        elif event == cv2.EVENT_LBUTTONUP:
            self._origin_disp = (x, y)
            self._cursor_disp = (x, y)

    def _cb_draw(self, event, x, y, flags, _):
        if event == cv2.EVENT_MOUSEWHEEL:
            self._zoom_at(x, y, 1.15 if flags > 0 else 1 / 1.15)
        elif event == cv2.EVENT_LBUTTONDOWN:
            self._p1 = self._p2 = (x, y)
            self._drawing = True
        elif event == cv2.EVENT_MOUSEMOVE and self._drawing:
            self._p2 = (x, y)
        elif event == cv2.EVENT_LBUTTONUP:
            self._p2      = (x, y)
            self._drawing = False

    # ── Public interface ──────────────────────────────────────────────────

    def navigate(self):
        """Phase 1: choose the frame on which to initialise tracking."""
        WIN = "Navigate: arrows=±1 frame, W/S=±10, +/-=zoom, IJKL=pan, drag=pan, ENTER=confirm"
        cv2.namedWindow(WIN, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(WIN, self.dw, self.dh)
        cv2.setMouseCallback(WIN, self._cb_nav)

        hint = "← →/A D=±1  W/S=±10  +/-=zoom  IJKL=pan  drag=pan  ENTER=select frame"
        while True:
            frame = self._cache.get(self.frame_idx)
            if frame is None:
                break
            cv2.imshow(WIN, self._render(frame, hint))
            key = cv2.waitKeyEx(20)

            if   key in (KEY_LEFT,  ord("a")): self.frame_idx = max(0, self.frame_idx - 1)
            elif key in (KEY_RIGHT, ord("d")): self.frame_idx = min(self.total_frames - 1, self.frame_idx + 1)
            elif key in (KEY_UP,    ord("w")): self.frame_idx = min(self.total_frames - 1, self.frame_idx + 10)
            elif key in (KEY_DOWN,  ord("s")): self.frame_idx = max(0, self.frame_idx - 10)
            elif key in (KEY_ENTER, KEY_SPACE): break
            elif key == KEY_ESC:
                cv2.destroyWindow(WIN)
                print("Cancelled.")
                sys.exit(0)
            else:
                self._zoom_pan_keys(key)

        cv2.destroyWindow(WIN)
        return self.frame_idx, self._cache.get(self.frame_idx)

    def set_origin(self, frame):
        """Phase 2: click to set the coordinate origin (0,0). Returns (ox, oy) in original frame coords."""
        WIN = "Set origin: click the reference point (0,0)  |  +/-=zoom  IJKL=pan  ENTER=confirm"
        cv2.namedWindow(WIN, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(WIN, self.dw, self.dh)
        cv2.setMouseCallback(WIN, self._cb_origin)
        self._origin_disp = None

        PINK = (180, 105, 255)  # BGR hot pink
        hint = "cursor = 0,0  |  click to fix  |  +/-=zoom  IJKL=pan  ENTER=confirm"

        def overlay(disp):
            pt = self._origin_disp if self._origin_disp else self._cursor_disp
            if pt is None:
                return
            cx_d, cy_d = pt
            h_d, w_d = disp.shape[:2]
            # full vertical line = Y axis
            cv2.line(disp, (cx_d, 0), (cx_d, h_d), PINK, 1)
            # full horizontal line = X axis
            cv2.line(disp, (0, cy_d), (w_d, cy_d), PINK, 1)
            # origin dot + labels
            cv2.circle(disp, (cx_d, cy_d), 5, PINK, -1)
            cv2.putText(disp, "Y", (cx_d + 6, 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, PINK, 2)
            cv2.putText(disp, "X", (w_d - 22, cy_d - 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, PINK, 2)
            if self._origin_disp:
                cv2.putText(disp, "0,0", (cx_d + 6, cy_d - 8),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.45, PINK, 1)

        while True:
            cv2.imshow(WIN, self._render(frame, hint, overlay_fn=overlay))
            key = cv2.waitKeyEx(20)

            if key in (KEY_ENTER, KEY_SPACE):
                if self._origin_disp:
                    break
            elif key == KEY_ESC:
                cv2.destroyWindow(WIN)
                print("Cancelled.")
                sys.exit(0)
            else:
                self._zoom_pan_keys(key)

        cv2.destroyWindow(WIN)
        ox, oy = self._d2o(*self._origin_disp)
        ox, oy = int(np.clip(ox, 0, self.fw - 1)), int(np.clip(oy, 0, self.fh - 1))
        print(f"  origin: pixel ({ox}, {oy})")
        return ox, oy

    def draw_bbox(self, frame):
        """Phase 3: draw bounding box. Returns (x,y,w,h) in original frame coords."""
        WIN = "Draw bbox: click+drag  |  +/-=zoom  arrows/IJKL=pan  ENTER=confirm  R=redo"
        cv2.namedWindow(WIN, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(WIN, self.dw, self.dh)
        cv2.setMouseCallback(WIN, self._cb_draw)
        self._p1 = self._p2 = None

        hint = "click+drag=draw  |  +/-=zoom  IJKL/arrows=pan  ENTER=confirm  R=redo"
        while True:
            disp = self._render(frame, hint)
            if self._p1 and self._p2 and self._p1 != self._p2:
                cv2.rectangle(disp, self._p1, self._p2, (0, 255, 0), 2)
            cv2.imshow(WIN, disp)
            key = cv2.waitKeyEx(20)

            if   key in (ord("+"), ord("=")):  self._zoom_at(self.dw // 2, self.dh // 2, 1.25)
            elif key == ord("-"):              self._zoom_at(self.dw // 2, self.dh // 2, 1 / 1.25)
            elif key in (ord("i"), KEY_UP):    self._pan_by(0, -80)
            elif key in (ord("k"), KEY_DOWN):  self._pan_by(0,  80)
            elif key in (ord("j"), KEY_LEFT):  self._pan_by(-80, 0)
            elif key in (ord("l"), KEY_RIGHT): self._pan_by( 80, 0)
            elif key in (KEY_ENTER, KEY_SPACE):
                if self._p1 and self._p2 and self._p1 != self._p2:
                    break
            elif key in (ord("r"), ord("R")):
                self._p1 = self._p2 = None
            elif key == KEY_ESC:
                cv2.destroyWindow(WIN)
                print("Cancelled.")
                sys.exit(0)

        cv2.destroyWindow(WIN)

        x1d = min(self._p1[0], self._p2[0]);  x2d = max(self._p1[0], self._p2[0])
        y1d = min(self._p1[1], self._p2[1]);  y2d = max(self._p1[1], self._p2[1])
        ox1, oy1 = self._d2o(x1d, y1d)
        ox2, oy2 = self._d2o(x2d, y2d)
        ox1 = max(0, int(ox1));  oy1 = max(0, int(oy1))
        ox2 = min(self.fw, int(ox2)); oy2 = min(self.fh, int(oy2))
        bbox = (ox1, oy1, ox2 - ox1, oy2 - oy1)
        print(f"  bbox: x={bbox[0]} y={bbox[1]} w={bbox[2]} h={bbox[3]}")
        return bbox

    # ── Scale mouse callback ──────────────────────────────────────────────

    def _cb_scale(self, event, x, y, flags, _):
        if self._sphase != "line":
            return
        if event == cv2.EVENT_MOUSEWHEEL:
            self._zoom_at(x, y, 1.15 if flags > 0 else 1 / 1.15)
        elif event == cv2.EVENT_MOUSEMOVE:
            self._scursor = (x, y)
        elif event == cv2.EVENT_LBUTTONUP:
            if self._sp1 is None:
                self._sp1 = (x, y)
            else:
                self._sp2    = (x, y)
                self._sphase = "text"

    def set_scale(self, frame):
        """
        Phase 3: draw a reference line over a known distance, then type its
        length in metres. Returns metres_per_pixel (float).
        """
        PINK = (180, 105, 255)

        WIN = "Set scale: click two points on a known distance, type length in metres, ENTER"
        cv2.namedWindow(WIN, cv2.WINDOW_NORMAL)
        cv2.resizeWindow(WIN, self.dw, self.dh)
        cv2.setMouseCallback(WIN, self._cb_scale)

        self._sp1    = self._sp2 = self._scursor = None
        self._sinput = ""
        self._sphase = "line"

        while True:
            disp = self._render(frame,
                                "click pt1 then pt2 on known distance  |  +/-=zoom  IJKL=pan"
                                if self._sphase == "line" else
                                "type length in metres  |  ENTER=confirm  R=redo line")

            # ── draw reference line ───────────────────────────────────────
            p1 = self._sp1
            p2 = self._sp2 if self._sp2 else self._scursor
            if p1 and p2 and p1 != p2:
                cv2.line(disp, p1, p2, PINK, 2)
                cv2.circle(disp, p1, 5, PINK, -1)
                cv2.circle(disp, p2, 5, PINK, -1)
                px_len = np.hypot(p2[0] - p1[0], p2[1] - p1[1])
                mid = ((p1[0] + p2[0]) // 2, (p1[1] + p2[1]) // 2)
                cv2.putText(disp, f"{px_len:.0f} px", (mid[0] + 6, mid[1] - 6),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, PINK, 1)
            elif p1:
                cv2.circle(disp, p1, 5, PINK, -1)

            # ── text input overlay ────────────────────────────────────────
            if self._sphase == "text":
                h_d = disp.shape[0]
                overlay = disp.copy()
                cv2.rectangle(overlay, (0, h_d - 70), (self.dw, h_d), (20, 20, 20), -1)
                disp = cv2.addWeighted(overlay, 0.75, disp, 0.25, 0)
                cv2.putText(disp, "Length in metres: " + self._sinput + "|",
                            (10, h_d - 38), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
                cv2.putText(disp, "ENTER = confirm   R = redo line",
                            (10, h_d - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (180, 180, 180), 1)

            cv2.imshow(WIN, disp)
            key = cv2.waitKeyEx(20)

            if self._sphase == "line":
                if key in (KEY_ENTER, KEY_SPACE):
                    pass  # need two points first
                elif key == KEY_ESC:
                    cv2.destroyWindow(WIN); print("Cancelled."); sys.exit(0)
                else:
                    self._zoom_pan_keys(key)
            else:  # "text"
                if key in (KEY_ENTER, KEY_SPACE):
                    try:
                        val = float(self._sinput)
                        if val > 0:
                            break
                    except ValueError:
                        pass
                elif key in (8, 127):           # backspace
                    self._sinput = self._sinput[:-1]
                elif 48 <= key <= 57:           # digits 0-9
                    self._sinput += chr(key)
                elif key == ord(".") and "." not in self._sinput:
                    self._sinput += "."
                elif key in (ord("r"), ord("R")):
                    self._sp1 = self._sp2 = self._scursor = None
                    self._sinput = ""
                    self._sphase = "line"
                    cv2.setMouseCallback(WIN, self._cb_scale)
                elif key == KEY_ESC:
                    cv2.destroyWindow(WIN); print("Cancelled."); sys.exit(0)

        cv2.destroyWindow(WIN)

        # map both points to original-frame coords, compute real pixel distance
        ox1, oy1 = self._d2o(*self._sp1)
        ox2, oy2 = self._d2o(*self._sp2)
        px_dist = np.hypot(ox2 - ox1, oy2 - oy1)
        metres  = float(self._sinput)
        mpp     = metres / px_dist
        print(f"  scale: {px_dist:.1f} px = {metres} m  →  {mpp:.6f} m/px")
        return mpp


# ── Tracking validation ────────────────────────────────────────────────────────

def _extract_template(frame, bbox):
    x, y, w, h = [max(0, int(v)) for v in bbox]
    region = frame[y:y+h, x:x+w]
    if region.size == 0:
        return None
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY) if region.ndim == 3 else region
    return gray.copy()


def _validate(frame, bbox, prev_cx, prev_cy, template, fw, fh, ncc_thresh, jump_ratio):
    """
    Returns (valid, score). Three independent checks — any failure → LOST:
      1. Bounds : bbox must be fully inside the frame.
      2. Jump   : center must not move more than jump_ratio * diagonal in one frame.
      3. NCC    : tracked region must resemble the initial template.
    """
    x, y, w, h = [int(v) for v in bbox]
    if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > fw or y + h > fh:
        return False, 0.0
    if prev_cx is not None:
        dist = np.hypot(x + w / 2 - prev_cx, y + h / 2 - prev_cy)
        if dist > np.hypot(fw, fh) * jump_ratio:
            return False, 0.0
    if template is not None and w >= 4 and h >= 4:
        region = frame[y:y+h, x:x+w]
        rg   = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY) if region.ndim == 3 else region
        tmpl = cv2.resize(template, (rg.shape[1], rg.shape[0]))
        score = float(cv2.matchTemplate(rg, tmpl, cv2.TM_CCOEFF_NORMED)[0, 0])
        return score >= ncc_thresh, score
    return True, 1.0


# ── NaN interpolation ─────────────────────────────────────────────────────────

def _interpolate_records(records):
    """
    Fill NaN gaps with linear interpolation between the surrounding valid frames
    (continuous-motion assumption). Gaps at the very start or end of the sequence
    — where there is no valid neighbour on one side — are left as NaN.
    """
    n      = len(records)
    result = list(records)
    i      = 0

    while i < n:
        if result[i][2] is None:
            gap_start = i
            while i < n and result[i][2] is None:
                i += 1
            gap_end = i  # index of first valid frame after the gap (or n)

            prev_i = gap_start - 1
            next_i = gap_end

            if prev_i < 0 or next_i >= n:
                continue  # edge gap — nothing to interpolate against

            px, py = result[prev_i][2], result[prev_i][3]
            nx, ny = result[next_i][2], result[next_i][3]
            gap_len = gap_end - gap_start

            for j in range(gap_len):
                t  = (j + 1) / (gap_len + 1)
                ix = px + t * (nx - px)
                iy = py + t * (ny - py)
                fi, ts, _, _ = result[gap_start + j]
                result[gap_start + j] = (fi, ts, round(ix, 3), round(iy, 3))
        else:
            i += 1

    return result


def _trim_edge_nans(records):
    """Remove leading and trailing rows where the position is None (ball not visible)."""
    start = 0
    while start < len(records) and records[start][2] is None:
        start += 1
    end = len(records) - 1
    while end >= start and records[end][2] is None:
        end -= 1
    return records[start:end + 1]


# ── Velocity ──────────────────────────────────────────────────────────────────

def _compute_velocity(records, fps):
    """
    Add vx, vy via central finite differences (coordinate units per second).
    Falls back to one-sided differences at the edges.
    NaN positions produce NaN velocities.
    """
    n   = len(records)
    out = []
    for i, (fi, t, x, y) in enumerate(records):
        if x is None:
            out.append((fi, t, x, y, None, None))
            continue

        x_prev = y_prev = dt_prev = None
        x_next = y_next = dt_next = None

        if i > 0 and records[i - 1][2] is not None:
            x_prev, y_prev = records[i - 1][2], records[i - 1][3]
            dt_prev = t - records[i - 1][1]

        if i < n - 1 and records[i + 1][2] is not None:
            x_next, y_next = records[i + 1][2], records[i + 1][3]
            dt_next = records[i + 1][1] - t

        if x_prev is not None and x_next is not None:
            span = dt_prev + dt_next
            vx = (x_next - x_prev) / span
            vy = (y_next - y_prev) / span
        elif x_next is not None:
            vx = (x_next - x) / dt_next
            vy = (y_next - y) / dt_next
        elif x_prev is not None:
            vx = (x - x_prev) / dt_prev
            vy = (y - y_prev) / dt_prev
        else:
            vx = vy = None

        out.append((fi, t, x, y,
                    None if vx is None else round(vx, 3),
                    None if vy is None else round(vy, 3)))
    return out


# ── Main tracker loop ──────────────────────────────────────────────────────────

def run_tracker(input_path, output_dir, preview, ncc_threshold, max_jump_ratio):
    cap, fps, fw, fh, total_frames = load_video(input_path)

    # ── Setup phases ──────────────────────────────────────────────────────
    sel = InteractiveSelector(cap, total_frames, fps, fw, fh)
    start_idx, init_frame = sel.navigate()
    origin_x, origin_y   = sel.set_origin(init_frame)
    mpp                   = sel.set_scale(init_frame)   # metres per pixel
    bbox                  = sel.draw_bbox(init_frame)

    if bbox[2] <= 0 or bbox[3] <= 0:
        print("Invalid bbox — exiting.")
        sys.exit(1)

    template = _extract_template(init_frame, bbox)

    tracker = cv2.TrackerCSRT_create()
    tracker.init(init_frame, bbox)
    print(f"Tracker initialised on frame {start_idx}.")
    print(f"Validation: ncc_threshold={ncc_threshold}  max_jump={max_jump_ratio}")

    # ── Output paths ──────────────────────────────────────────────────────
    os.makedirs(output_dir, exist_ok=True)
    stem      = os.path.splitext(os.path.basename(input_path))[0]
    vid_out   = os.path.join(output_dir, f"{stem}_tracked.mp4")
    # CSV goes next to the original video
    video_dir = os.path.dirname(os.path.abspath(input_path))
    csv_out   = os.path.join(video_dir, f"{stem}_track.csv")

    writer = cv2.VideoWriter(vid_out, cv2.VideoWriter_fourcc(*"mp4v"), fps, (fw, fh))

    dw, dh = _disp_size(fw, fh)
    if preview:
        cv2.namedWindow("Tracking", cv2.WINDOW_NORMAL)
        cv2.resizeWindow("Tracking", dw, dh)

    records         = []
    x0, y0, w0, h0  = [int(v) for v in bbox]
    prev_cx, prev_cy = x0 + w0 / 2, y0 + h0 / 2
    last_valid_bbox  = bbox

    def annotate(frame, bbox_to_draw, color, lost=False):
        """Draw tracking box + axes indicator on a copy of frame."""
        vis = frame.copy()
        if bbox_to_draw is not None:
            bx, by, bw, bh = [int(v) for v in bbox_to_draw]
            cv2.rectangle(vis, (bx, by), (bx+bw, by+bh), color, 2)
            if lost:
                cv2.putText(vis, "LOST", (bx, max(by - 6, 12)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)
        _draw_axes(vis, origin_x, origin_y)
        return vis

    # ── Pre-tracking frames (0 → start_idx-1): write with axes, no box ───
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    t0 = time.time()

    for fi in range(start_idx):
        ret, frame = cap.read()
        if not ret:
            break
        vis = annotate(frame, None, (0, 0, 0))
        writer.write(vis)
        if preview:
            cv2.imshow("Tracking", cv2.resize(vis, (dw, dh)))
            if cv2.waitKey(1) & 0xFF == ord("q"):
                print("Aborted by user.")
                cap.release(); writer.release(); cv2.destroyAllWindows(); sys.exit(0)

    # ── Init frame ────────────────────────────────────────────────────────
    vis0 = annotate(init_frame, bbox, (0, 255, 0))
    writer.write(vis0)
    cx0_w = prev_cx - origin_x
    cy0_w = -(prev_cy - origin_y)
    records.append((start_idx, round(start_idx / fps, 4), cx0_w, cy0_w))
    if preview:
        cv2.imshow("Tracking", cv2.resize(vis0, (dw, dh)))
        cv2.waitKey(1)

    # ── Tracking loop (start_idx+1 → end) ────────────────────────────────
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_idx + 1)

    for fi in range(start_idx + 1, total_frames):
        ret, frame = cap.read()
        if not ret:
            break

        ok, new_bbox = tracker.update(frame)

        if ok:
            valid, score = _validate(frame, new_bbox, prev_cx, prev_cy,
                                     template, fw, fh, ncc_threshold, max_jump_ratio)
        else:
            valid, score = False, 0.0

        t = round(fi / fps, 4)

        if valid:
            x, y, w, h = [int(v) for v in new_bbox]
            cx, cy = x + w / 2, y + h / 2
            prev_cx, prev_cy = cx, cy
            last_valid_bbox  = new_bbox
            wx = cx - origin_x
            wy = -(cy - origin_y)
            records.append((fi, t, wx, wy))
            vis = annotate(frame, new_bbox, (0, 255, 0))
        else:
            records.append((fi, t, None, None))
            vis = annotate(frame, last_valid_bbox, (0, 0, 180), lost=True)

        writer.write(vis)

        if preview:
            cv2.imshow("Tracking", cv2.resize(vis, (dw, dh)))
            if cv2.waitKey(1) & 0xFF == ord("q"):
                print("Aborted by user.")
                break

    elapsed = time.time() - t0
    cap.release()
    writer.release()
    cv2.destroyAllWindows()

    # ── Interpolate NaN gaps, trim edges, compute velocity ───────────────
    lost_before = sum(1 for r in records if r[2] is None)
    records     = _interpolate_records(records)
    records     = _trim_edge_nans(records)
    records     = _compute_velocity(records, fps)

    # ── Apply scale (pixels → metres) ────────────────────────────────────
    def _scale(v):
        return None if v is None else round(v * mpp, 6)

    records = [(fi, t, _scale(x), _scale(y), _scale(vx), _scale(vy))
               for fi, t, x, y, vx, vy in records]

    # ── Write CSV (no header: time, x, y, vx, vy) ────────────────────────
    with open(csv_out, "w", newline="") as f:
        cw = csv.writer(f)
        for r in records:
            cw.writerow([r[1],
                         "" if r[2] is None else round(r[2], 6),
                         "" if r[3] is None else round(r[3], 6),
                         "" if r[4] is None else round(r[4], 6),
                         "" if r[5] is None else round(r[5], 6)])

    tracked = sum(1 for r in records if r[2] is not None)
    lost    = sum(1 for r in records if r[2] is None)
    print(f"\n  Frames tracked     : {tracked}")
    print(f"  Frames interpolated: {lost_before - lost}")
    print(f"  Frames lost (NaN)  : {lost}")
    print(f"  Wall-clock       : {elapsed:.1f}s  (video ~{total_frames / fps:.1f}s)")
    print(f"  Video            : {vid_out}")
    print(f"  CSV              : {csv_out}")

    # ── Excel report ──────────────────────────────────────────────────────
    write_report(csv_out)


# ── Entry point ────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="CSRT tracker with frame selection, axes, and NaN-on-lost")
    ap.add_argument("video",           help="Input video path")
    ap.add_argument("--output-dir",    default="output",
                    help="Directory for annotated video (default: output/)")
    ap.add_argument("--no-preview",    action="store_true",
                    help="Skip live preview window")
    ap.add_argument("--ncc-threshold", type=float, default=0.35,
                    help="NCC similarity floor — below this → LOST (default 0.35)")
    ap.add_argument("--max-jump",      type=float, default=0.40,
                    help="Max center jump as fraction of frame diagonal (default 0.40)")
    args = ap.parse_args()

    run_tracker(args.video, args.output_dir,
                preview=not args.no_preview,
                ncc_threshold=args.ncc_threshold,
                max_jump_ratio=args.max_jump)


if __name__ == "__main__":
    main()
