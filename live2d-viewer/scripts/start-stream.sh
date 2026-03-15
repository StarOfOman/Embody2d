#!/bin/bash
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99
sleep 2

chromium-browser \
  --headless=new \
  --disable-gpu=false \
  --use-gl=egl \
  --no-sandbox \
  --window-size=1280,720 \
  "${AVATAR_URL}?id=streamer" &

sleep 3

ffmpeg -f x11grab -r 30 -s 1280x720 -i :99 \
  -c:v h264_nvenc -preset fast \
  -f rtsp "${STREAM_OUT}"
