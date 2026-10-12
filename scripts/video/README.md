# Video segment recorder

Continuously records the Axis RTSP stream to an external SSD as fixed-duration MP4
segments, and maintains a SQLite index on the drive mapping every segment file to its
global start/end time and camera id.

**This is a separate process from the Supabase pipeline.** It shares no imports, no
config and no state with `supabase_sync.py` / `yolo_plate_reader.py`, and can be
started, tested and stopped completely independently.

## No re-encoding, ever

The Orin Nano has no hardware encoder. The pipeline is a pure remux — the camera's
native H.264 elementary stream is depayloaded and written straight into MP4:

```
rtspsrc ! rtph264depay ! h264parse ! [ mp4mux ]  <- inside splitmuxsink
```

No decoder or encoder element is ever instantiated. `--verify-no-encode` below shows
how to prove that on a live run.

## Setup (JetPack)

GStreamer bindings must come from apt, not pip — PyGObject has to match the system
GStreamer. Do **not** add these to `scripts/inductiverobo.txt`; that file is installed
with `--no-deps` for the inference environment and is unrelated to this process.

```bash
sudo apt install -y \
    python3-gi python3-gi-cairo gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 \
    gstreamer1.0-tools gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
    ffmpeg sqlite3 udisks2
```

### Format and identify the SSD

`ext4` is the right choice if the drive only ever mounts on the Orin — it journals,
and an unclean unplug is far less damaging than on exFAT. Use exFAT only if you also
need to read the drive on macOS/Windows.

```bash
sudo mkfs.ext4 -L GATF-VIDEO /dev/sda1
lsblk -o NAME,UUID,LABEL,FSTYPE,MOUNTPOINT      # copy the UUID
sudo chown "$USER" /media/$USER/GATF-VIDEO      # after mounting
```

The UUID is the permanent handle. Nothing in the config or the index refers to a
mountpoint or a `/dev` node, so moving the drive to a different USB port or cable
changes nothing.

### Configure

```bash
cp scripts/video/recorder.config.example.json scripts/video/recorder.config.json
$EDITOR scripts/video/recorder.config.json      # drive_uuid, camera ip, segment_seconds
export CAM01_USER='root' CAM01_PASS='...'       # or reuse the existing .camera_config
python3 -m scripts.video.recorder --init-drive --label field-ssd-01
```

`recorder.config.json` is gitignored. **Credentials are never written into it**, nor
into the index, filenames, logs or `drive.json` — only a redacted
`rtsp://<redacted>@<ip>/...` is stored. (This is the bug worth avoiding: the existing
event pipeline writes its raw `--source` string into `event.json` and on to Postgres,
which would leak the RTSP password verbatim if a live URL were ever passed.)

## Running

```bash
python3 -m scripts.video.preflight --camera gatf-lot-01     # always run this first
python3 -m scripts.video.recorder  --camera gatf-lot-01
```

Stop with `Ctrl-C` or `SIGTERM`. Either sends EOS through the pipeline and waits for
the in-flight segment to close, which is what lets `mp4mux` write its final `moov`
atom. `kill -9` truncates that segment instead.

Other subcommands (these work on any machine with plain Python — no GStreamer needed,
so you can plug the drive into a laptop to inspect it):

| Command | Purpose |
| --- | --- |
| `--status` | segment count, coverage window, free space |
| `--export-csv` | refresh `segments.csv` from the database |
| `--reconcile` | rebuild the index from what is actually on disk (crash recovery) |
| `--test-file X.mp4 --test-drive-root DIR` | exercise the whole path with no camera and no SSD |

## Safe removal

```bash
scripts/video/eject.sh <drive_uuid>
```

Stops the recorder gracefully, checkpoints the WAL back into `segments.db`, runs
`integrity_check`, refreshes `segments.csv`, `sync`s, **refuses to unmount if any
process still holds the drive open** (naming it), then unmounts and powers down the
USB bridge. It prints `SAFE TO UNPLUG` only on full success, and exits non-zero
otherwise.

## Layout on the drive

```
<mount>/gatf/
  drive.json                 # drive_uuid, label, filesystem, created_utc
  index/segments.db          # SQLite, WAL, synchronous=FULL
  index/segments.csv         # portable mirror, rewritten on stop and on eject
  video/<camera_id>/<YYYY-MM-DD>/<camera_id>_<YYYYMMDDTHHMMSSffffff>Z.mp4
  logs/recorder-<camera_id>.log
  logs/recorder.pid
```

Segment filenames use the same UTC convention as the event directories in `events/`
(`%Y%m%dT%H%M%S%f` + `Z`), deliberately *not* `capture.sh`'s local-time format, so
segment names and event names sort and correlate directly. The filename timestamp is
taken when the fragment opens; the **authoritative** window is `start_utc`/`end_utc`
in the index.

### `segments` table

`filename` (PK, relative to `gatf/`), `camera_id`, `session_id`, `drive_uuid`,
`start_utc`, `end_utc`, `duration_s`, `start_running_ns`, `end_running_ns`,
`size_bytes`, `fragment_id`, `complete`, `deleted_utc`.

Wall-clock boundaries are computed as `session_epoch + running_time`, anchored once
per session, rather than read from the clock when the bus message arrives — that keeps
consecutive segments exactly contiguous instead of accumulating latency jitter at
every boundary. With `ntp_sync` on, the epoch tracks the camera's RTCP sender-report
clock. Raw running-times are kept alongside so the mapping stays auditable.

`complete = 0` marks a segment truncated by an unclean stop. Retention **tombstones**
rows (`deleted_utc`) rather than deleting them, so the record of what was captured
survives the pruning of the footage.

Each reconnect opens a new `recording_sessions` row, so gaps from camera reboots or
network drops stay visible in the index rather than being papered over.

## Verification

**1. Offline — no camera, no SSD.** Runs the real splitmuxsink path against an
existing capture:

```bash
python3 -m scripts.video.recorder --camera gatf-lot-01 --segment-seconds 10 \
    --test-file camera_captures/capture_20260813_205719.mp4 \
    --test-drive-root /tmp/fakedrive
python3 -m scripts.video.recorder --test-drive-root /tmp/fakedrive --status
```

**2. Prove there is no re-encode.** During a short run:

```bash
GST_DEBUG=GST_ELEMENT_FACTORY:4 python3 -m scripts.video.recorder --camera gatf-lot-01 --duration 60 2>&1 \
  | grep -Ei 'creating element.*(dec|enc)'      # must print nothing
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,profile,level,width,height,r_frame_rate \
  -of default=nw=1 <segment.mp4>                # must match the source stream exactly
```

**3. Segment timing and index integrity.** After ~30 minutes:

```sql
SELECT count(*), min(start_utc), max(end_utc), round(avg(duration_s),2),
       round(sum(size_bytes)/1e9,2) AS gb
FROM segments WHERE deleted_utc IS NULL;

-- every row's start should equal the previous row's end; anything else is a gap
SELECT filename, start_utc,
       LAG(end_utc) OVER (PARTITION BY camera_id ORDER BY start_utc) AS prev_end
FROM segments ORDER BY start_utc;
```

Then confirm `count(rows) == count(*.mp4 on disk)` and that sizes match.

**4. Reconnect.** Unplug the camera's Ethernet for ~60s mid-run. Expect an error, a
backoff, a reconnect, a **new** `recording_sessions` row, and a visible gap in the
query above rather than a silently continuous-looking timeline.

**5. Unclean unplug — the important one.** Pull the SSD while recording, re-plug, then
`--reconcile`. `PRAGMA integrity_check` must return `ok`, at most the single in-flight
segment should be affected, and it should be marked `complete = 0`. With
`fragmented_mp4: true` that truncated file still plays up to the cut point.

**6. Eject.** `eject.sh` prints `SAFE TO UNPLUG`; no `-wal`/`-shm` files remain beside
the database; the drive is gone from `lsblk`. Separately confirm it **refuses** while
the recorder is still running.

## Gotchas

- **Keyframe interval.** `splitmuxsink` can only cut on an IDR frame. If the camera's
  GOP is longer than `segment_seconds`, segments silently overrun. `preflight` measures
  this and fails loudly. Fix it on the camera (Axis: stream profile, or the
  `?videokeyframeinterval=N` query in the `query` config field), not in the pipeline.
- **`muxer-factory` / `muxer-properties` are only honoured when `async-finalize=true`.**
  That pairing is load-bearing for `fragmented_mp4`, not incidental.
- **Long GOPs and `min_free_gb`.** Retention runs on segment close, so the drive can
  dip below the threshold by up to one segment's worth. Leave headroom.
- **exFAT** has no journal and only a 4-byte volume serial for a "UUID"
  (`1234-ABCD`). It works, but `preflight` warns for good reason.

## Not in scope

Motion-gated recording, uploading video to Supabase, and joining segments to `events`
rows are all deliberately out. When the join is wanted, note that the inference scripts
record `frame_index` but not fps, so there is currently no frame → wall-clock mapping;
once both sides share a `camera_id` and UTC, the join is simply
`event.timestamp_utc BETWEEN segments.start_utc AND segments.end_utc`.
