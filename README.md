# Rastreador Modelagem

Python CLI tool for tracking objects in physics experiment videos. Uses OpenCV's CSRT tracker to follow a user-defined bounding box through a video, exporting position and velocity data as CSV and Excel.

## Features

- Interactive frame scrubber to pick the starting frame (zoom, pan)
- Click to set coordinate origin (0, 0) and draw the bounding box
- Draw a reference line over a known distance to set the pixel-to-metre scale
- CSRT tracking with NCC + jump validation — marks lost frames as NaN and interpolates gaps
- Outputs an annotated video, a CSV with `time, x, y, vx, vy` (in metres), and an Excel report

## Requirements

```
pip install opencv-contrib-python openpyxl
```

## Usage

```bash
python track.py <video_path> [--output-dir output/] [--no-preview] [--ncc-threshold 0.35] [--max-jump 0.40]
```

**Arguments**

| Flag | Default | Description |
|---|---|---|
| `video` | — | Path to input video |
| `--output-dir` | `output/` | Directory for the annotated video |
| `--no-preview` | off | Disable the live tracking window |
| `--ncc-threshold` | `0.35` | NCC similarity floor below which the tracker is marked as lost |
| `--max-jump` | `0.40` | Max center displacement per frame as a fraction of the frame diagonal |

## Output

- `output/<name>_tracked.mp4` — annotated video with bounding box and axes
- `<video_dir>/<name>_track.csv` — `time, x, y, vx, vy` in metres
- `<video_dir>/<name>_track_report.xlsx` — Excel report with the same data
