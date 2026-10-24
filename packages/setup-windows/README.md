# sure-mail setup (Windows)

The **first-install** half of the Windows release path. The payload updates
itself in place (`Settings → Updates → Install and restart`); this program is
what gets it there the first time, and what repairs an install that will not
start.

```
sure-mail-setup.exe
  1. reads  https://positronic-ai.us/downloads/sure-mail/latest.json
  2. downloads this machine's payload (win32-x64)
  3. verifies its SHA-256 against the manifest
  4. installs to %LOCALAPPDATA%\Programs\sure-mail\sure-mail.exe
  5. keeps the previous build as sure-mail.exe.old
  6. adds a Start Menu shortcut and starts it
```

About 850 KB, one file, no runtime: WinHTTP for the download, CryptoAPI for the
hash, `IShellLink` for the shortcut, `CreateProcess` for the launch.

## Why it downloads rather than embeds

Embedding the payload would make the setup 90 MB and stale the day it ships.
It is a *pointer*, so it always installs the current build — and the manifest is
the only place that changes on a release.

## Safety properties

- **Download to a temp file, verify, then move.** A truncated or altered
  download never becomes the installed client.
- **The installed bytes are hashed again** after the move, not just the temp
  copy — that is the file which will actually run. A mismatch restores the
  previous build.
- **The previous build is kept** (`sure-mail.exe.old`): a bad update is a rename
  away from undone.
- **A running image can be renamed but not overwritten**, which is why replacing
  a running install works at all; it is also the trick the payload's own updater
  uses.
- **A local `--payload` file is copied, never consumed** — that file belongs to
  the person who pointed at it.

## Options

```
--payload <file>   install from a local file (offline)
--sha256 <hex>     the file's expected SHA-256 (required with --payload)
--url <url>        download from this URL instead of the manifest
--manifest <url>   manifest to read (default: the published one)
--dir <path>       install directory (default: %LOCALAPPDATA%\Programs\sure-mail)
--no-launch        install only
--no-shortcut      do not create a Start Menu shortcut
--quiet            only errors, and no message box (what unattended runs use)
--version, --help
```

## Building

MSVC (what CI uses):

```
cl /nologo /O2 /W3 /DUNICODE /D_UNICODE /Fe:dist\sure-mail-setup.exe ^
   packages\setup-windows\setup.c ^
   /link winhttp.lib crypt32.lib ole32.lib uuid.lib shell32.lib user32.lib
```

MinGW (used for the wine test; `-static` matters, otherwise the wine prefix
reports `c0000135` for the missing runtime DLL):

```
x86_64-w64-mingw32-gcc -O2 -municode -static -o setup.exe setup.c \
  -lwinhttp -lcrypt32 -lole32 -luuid -lshell32 -luser32
```

## Testing

`npm` does not build this — the repo's Linux dev loop has no Windows
toolchain — so the checks live in CI (`bootstrap (Windows)` job) and by hand:

```powershell
.\sure-mail-setup.exe --dir "$env:TEMP\sm" --no-launch   # real network path
Test-Path "$env:TEMP\sm\sure-mail.exe"                    # installed
& "$env:TEMP\sm\sure-mail.exe" --version                  # runs, prints build
```

Under wine on the dev box the same run takes ~8 s (85.8 MB download) and the
offline path is a second of file copying:

```
wine setup.exe --payload payload.bin --sha256 <hash> --dir Z:\tmp\out --no-launch --no-shortcut
```

Note: the Windows build is unsigned, so SmartScreen shows *"Windows protected
your PC"* — **More info → Run anyway**. That tax disappears with a code-signing
certificate; see `plan/spec/distribution.md`.
