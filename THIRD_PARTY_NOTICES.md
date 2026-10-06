# Third-party software

Diskcorder itself is released under the [MIT License](LICENSE). The Windows
installer and portable build also ship the following third-party software.

## FFmpeg (bundled binary)

- **What:** a static 64-bit Windows build of FFmpeg 6.1.1 ("essentials" build from
  [www.gyan.dev](https://www.gyan.dev/ffmpeg/builds/)), obtained through the
  [`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static) npm package.
- **License:** GNU General Public License v3 (the build is configured with
  `--enable-gpl --enable-version3`). The license text and the build configuration
  are included with every release as `ffmpeg-LICENSE.txt` and `ffmpeg-README.txt`
  in the application's `resources` folder.
- **Source code:** <https://github.com/FFmpeg/FFmpeg/commit/e38092ef93> and
  <https://ffmpeg.org/download.html>.
- **How it is used:** Diskcorder starts `ffmpeg.exe` as a separate process (to make
  thumbnails and preview clips, read media info and test files). It is not linked
  into Diskcorder, and Diskcorder's own code stays MIT-licensed. Nothing it produces
  is uploaded anywhere.
- **Replacing it:** ffmpeg is optional at runtime. If `ffmpeg.exe` is missing,
  Diskcorder still runs with media features disabled; a system `ffmpeg` on `PATH`
  is used as a fallback.

## npm dependencies (MIT)

| Package | License |
| --- | --- |
| [Electron](https://www.electronjs.org/) | MIT |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | MIT |
| [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) | MIT |

Electron also bundles Chromium and other components under their own licenses; the
full list ships with the application (`LICENSES.chromium.html`).
