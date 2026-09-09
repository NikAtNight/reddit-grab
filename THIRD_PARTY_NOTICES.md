# Third-party notices

This extension bundles the following packages so video and audio processing
stays local and complies with browser extension content-security policies:

- `@ffmpeg/ffmpeg` 0.12.15 — MIT license. See `vendor/ffmpeg/LICENSE`.
- `@ffmpeg/core` 0.12.10 — GPL-2.0-or-later. See `vendor/core/LICENSE`.

The checked-in browser files are reproducible with:

```sh
npm ci
npm run vendor:ffmpeg
```

The vendoring step restricts ffmpeg's worker to the packaged core rather than
allowing arbitrary runtime code URLs. Upstream source and build information:
<https://github.com/ffmpegwasm/ffmpeg.wasm>.
