/*
 * sure-mail setup — the Windows bootstrap.
 *
 * First install: reads the published manifest, downloads this machine's payload,
 * verifies its SHA-256, installs it under %LOCALAPPDATA%\Programs\sure-mail,
 * creates a Start Menu shortcut and starts it. After that the payload updates
 * itself (Settings -> Updates -> Install and restart), so this program is only
 * needed again to recover a broken install.
 *
 * Order matters: download to a temporary file, verify, then move into place.
 * A corrupt or truncated download must never become the installed client, and
 * the previous build is kept beside the new one as sure-mail.exe.old.
 *
 * Build (MSVC):
 *   cl /O2 /DUNICODE /D_UNICODE setup.c /link winhttp.lib crypt32.lib ole32.lib
 *      uuid.lib shell32.lib user32.lib advapi32.lib
 * Build (MinGW, used for the wine test):
 *   x86_64-w64-mingw32-gcc -O2 -municode -o setup.exe setup.c
 *      -lwinhttp -lcrypt32 -lole32 -luuid -lshell32 -luser32
 */

#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <strsafe.h>
#include <winhttp.h>
#include <wincrypt.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "uuid.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "advapi32.lib")

#define SETUP_VERSION "0.1.0"
#define DEFAULT_MANIFEST L"https://positronic-ai.us/downloads/sure-mail/latest.json"
#define USER_AGENT L"sure-mail-setup/" L"0.1.0"
#define ASSET_KEY "win32-x64"
#define BUFSZ 1024

static BOOL g_quiet = FALSE;

/* ---------------------------------------------------------------- messages */

static void msg(const wchar_t *fmt, ...)
{
    va_list ap;
    if (g_quiet) return;
    va_start(ap, fmt);
    vfwprintf(stdout, fmt, ap);
    va_end(ap);
    fflush(stdout);
}

static void describe(DWORD code, wchar_t *out, DWORD cap)
{
    DWORD n;
    n = FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                       NULL, code, 0, out, cap, NULL);
    if (n == 0) {
        StringCchPrintfW(out, cap, L"error %lu", (unsigned long)code);
    } else {
        while (n > 0 && (out[n - 1] == L'\r' || out[n - 1] == L'\n' || out[n - 1] == L' ')) {
            out[--n] = L'\0';
        }
    }
}

static int fail(const wchar_t *fmt, ...)
{
    wchar_t text[BUFSZ];
    va_list ap;
    va_start(ap, fmt);
    vswprintf(text, BUFSZ, fmt, ap);
    va_end(ap);
    fwprintf(stderr, L"sure-mail setup: %ls\n", text);
    fflush(stderr);
    /* A double-clicked console window vanishes on exit, so the one thing a
       person must see is shown in a dialog as well. --quiet is also what
       unattended runs use: a modal dialog would hang a CI job. */
    if (!g_quiet) MessageBoxW(NULL, text, L"sure-mail setup", MB_ICONERROR | MB_OK);
    return 1;
}

/* ------------------------------------------------------------------- paths */

static BOOL path_join(const wchar_t *dir, const wchar_t *name, wchar_t *out, DWORD cap)
{
    return SUCCEEDED(StringCchPrintfW(out, cap, L"%ls\\%ls", dir, name));
}

static BOOL dir_create(const wchar_t *dir)
{
    int rc;
    if (GetFileAttributesW(dir) != INVALID_FILE_ATTRIBUTES) return TRUE;
    rc = SHCreateDirectoryExW(NULL, dir, NULL);
    return rc == ERROR_SUCCESS || rc == ERROR_ALREADY_EXISTS || rc == ERROR_FILE_EXISTS;
}

/* --------------------------------------------------------------- hashing */

static BOOL file_sha256(const wchar_t *path, wchar_t hex[65], wchar_t *why, DWORD why_cap)
{
    HCRYPTPROV prov = 0;
    HCRYPTHASH hash = 0;
    HANDLE f = INVALID_HANDLE_VALUE;
    BYTE *buf = NULL;
    BYTE digest[32];
    DWORD read = 0, len = sizeof digest;
    BOOL ok = FALSE;
    int i;

    f = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    if (f == INVALID_HANDLE_VALUE) {
        StringCchPrintfW(why, why_cap, L"cannot open the file: ");
        describe(GetLastError(), why + wcslen(why), why_cap - (DWORD)wcslen(why));
        return FALSE;
    }
    if (!CryptAcquireContextW(&prov, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) {
        StringCchPrintfW(why, why_cap, L"cannot start SHA-256: ");
        describe(GetLastError(), why + wcslen(why), why_cap - (DWORD)wcslen(why));
        goto done;
    }
    if (!CryptCreateHash(prov, CALG_SHA_256, 0, 0, &hash)) {
        StringCchPrintfW(why, why_cap, L"cannot start SHA-256: ");
        describe(GetLastError(), why + wcslen(why), why_cap - (DWORD)wcslen(why));
        goto done;
    }
    buf = (BYTE *)malloc(65536);
    if (!buf) {
        StringCchPrintfW(why, why_cap, L"out of memory");
        goto done;
    }
    for (;;) {
        if (!ReadFile(f, buf, 65536, &read, NULL)) {
            StringCchPrintfW(why, why_cap, L"cannot read the file: ");
            describe(GetLastError(), why + wcslen(why), why_cap - (DWORD)wcslen(why));
            goto done;
        }
        if (read == 0) break;
        if (!CryptHashData(hash, buf, read, 0)) {
            StringCchPrintfW(why, why_cap, L"cannot hash the file: ");
            describe(GetLastError(), why + wcslen(why), why_cap - (DWORD)wcslen(why));
            goto done;
        }
    }
    if (!CryptGetHashParam(hash, HP_HASHVAL, digest, &len, 0)) {
        StringCchPrintfW(why, why_cap, L"cannot finish SHA-256: ");
        describe(GetLastError(), why + wcslen(why), why_cap - (DWORD)wcslen(why));
        goto done;
    }
    for (i = 0; i < 32; i++) {
        static const wchar_t *digits = L"0123456789abcdef";
        hex[i * 2] = digits[digest[i] >> 4];
        hex[i * 2 + 1] = digits[digest[i] & 0x0f];
    }
    hex[64] = L'\0';
    ok = TRUE;

done:
    if (hash) CryptDestroyHash(hash);
    if (prov) CryptReleaseContext(prov, 0);
    if (f != INVALID_HANDLE_VALUE) CloseHandle(f);
    free(buf);
    return ok;
}

/* -------------------------------------------------------------- downloads */

/*
 * GET `url` into `save_path`, or into a malloc'd buffer when `save_path` is
 * NULL. WinHTTP follows the redirect to the release CDN for us.
 */
static BOOL http_get(const wchar_t *url, const wchar_t *save_path, char **mem, DWORD *mem_len,
                     wchar_t *err, DWORD err_cap)
{
    URL_COMPONENTS uc;
    wchar_t host[256], target[4096];
    HINTERNET session = NULL, conn = NULL, req = NULL;
    HANDLE out = INVALID_HANDLE_VALUE;
    DWORD policy = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
    DWORD status = 0, status_len = sizeof status;
    DWORD total = 0, have_len = 0, len = 0;
    unsigned long long received = 0;
    BYTE *buf = NULL;
    char *acc = NULL;
    DWORD acc_len = 0, acc_cap = 0;
    BOOL ok = FALSE;

    ZeroMemory(&uc, sizeof uc);
    uc.dwStructSize = sizeof uc;
    uc.dwHostNameLength = (DWORD)-1;
    uc.dwUrlPathLength = (DWORD)-1;
    uc.dwExtraInfoLength = (DWORD)-1;
    uc.dwSchemeLength = (DWORD)-1;

    if (!WinHttpCrackUrl(url, 0, 0, &uc)) {
        StringCchPrintfW(err, err_cap, L"not a usable URL: %ls", url);
        return FALSE;
    }
    if (uc.dwHostNameLength >= 256 || uc.dwUrlPathLength + uc.dwExtraInfoLength >= 4096) {
        StringCchPrintfW(err, err_cap, L"URL is too long: %ls", url);
        return FALSE;
    }
    wcsncpy(host, uc.lpszHostName, uc.dwHostNameLength);
    host[uc.dwHostNameLength] = L'\0';
    wcsncpy(target, uc.lpszUrlPath, uc.dwUrlPathLength);
    if (uc.lpszExtraInfo) {
        wcsncpy(target + uc.dwUrlPathLength, uc.lpszExtraInfo, uc.dwExtraInfoLength);
        target[uc.dwUrlPathLength + uc.dwExtraInfoLength] = L'\0';
    } else {
        target[uc.dwUrlPathLength] = L'\0';
    }

    session = WinHttpOpen(USER_AGENT, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                          WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) {
        StringCchPrintfW(err, err_cap, L"cannot open a network session");
        goto done;
    }
    WinHttpSetTimeouts(session, 15000, 15000, 30000, 60000);
    WinHttpSetOption(session, WINHTTP_OPTION_REDIRECT_POLICY, &policy, sizeof policy);

    conn = WinHttpConnect(session, host, uc.nPort, 0);
    if (!conn) {
        StringCchPrintfW(err, err_cap, L"cannot connect to %ls", host);
        goto done;
    }
    req = WinHttpOpenRequest(conn, L"GET", target, NULL, WINHTTP_NO_REFERER,
                             WINHTTP_DEFAULT_ACCEPT_TYPES,
                             uc.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0);
    if (!req) {
        StringCchPrintfW(err, err_cap, L"cannot build the request for %ls", host);
        goto done;
    }
    if (!WinHttpSendRequest(req, WINHTTP_NO_ADDITIONAL_HEADERS, 0, NULL, 0, 0, 0) ||
        !WinHttpReceiveResponse(req, NULL)) {
        describe(GetLastError(), err, err_cap);
        goto done;
    }
    if (!WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_len,
                             WINHTTP_NO_HEADER_INDEX)) {
        status = 0;
    }
    if (status < 200 || status > 299) {
        StringCchPrintfW(err, err_cap, L"server answered HTTP %lu for %ls",
                         (unsigned long)status, url);
        goto done;
    }

    if (WinHttpQueryHeaders(req, WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &total, &have_len,
                            WINHTTP_NO_HEADER_INDEX) == FALSE) {
        total = 0;
    }

    if (save_path) {
        out = CreateFileW(save_path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                          FILE_ATTRIBUTE_NORMAL, NULL);
        if (out == INVALID_HANDLE_VALUE) {
            describe(GetLastError(), err, err_cap);
            goto done;
        }
    }

    buf = (BYTE *)malloc(65536);
    if (!buf) {
        StringCchPrintfW(err, err_cap, L"out of memory");
        goto done;
    }

    for (;;) {
        DWORD written = 0;
        if (!WinHttpReadData(req, buf, 65536, &len)) {
            describe(GetLastError(), err, err_cap);
            goto done;
        }
        if (len == 0) break;
        if (save_path) {
            if (!WriteFile(out, buf, len, &written, NULL) || written != len) {
                describe(GetLastError(), err, err_cap);
                goto done;
            }
        } else {
            if (acc_len + len > acc_cap) {
                DWORD cap = acc_cap ? acc_cap * 2 : 8192;
                char *grown;
                while (cap < acc_len + len) cap *= 2;
                grown = (char *)realloc(acc, cap);
                if (!grown) {
                    StringCchPrintfW(err, err_cap, L"out of memory");
                    goto done;
                }
                acc = grown;
                acc_cap = cap;
            }
            memcpy(acc + acc_len, buf, len);
            acc_len += len;
        }
        received += len;
        if (save_path && total > 0 && !g_quiet) {
            msg(L"\r  %5.1f MB of %5.1f MB", (double)received / 1048576.0,
                (double)total / 1048576.0);
        }
    }
    if (save_path && !g_quiet) msg(L"\r  %5.1f MB downloaded          \n", (double)received / 1048576.0);

    if (save_path) {
        FlushFileBuffers(out);
        CloseHandle(out);
        out = INVALID_HANDLE_VALUE;
    } else {
        acc = (char *)realloc(acc, acc_len + 1);
        if (acc) acc[acc_len] = '\0';
        *mem = acc;
        *mem_len = acc_len;
        acc = NULL;
    }
    ok = TRUE;

done:
    if (out != INVALID_HANDLE_VALUE) CloseHandle(out);
    if (req) WinHttpCloseHandle(req);
    if (conn) WinHttpCloseHandle(conn);
    if (session) WinHttpCloseHandle(session);
    free(buf);
    free(acc);
    if (!ok && save_path) DeleteFileW(save_path);
    return ok;
}

/* ------------------------------------------------------------ the manifest */

/* Copy the JSON string value for `key`, searching from offset `from`. */
static BOOL json_string(const char *json, DWORD len, DWORD from, const char *key,
                        char *out, DWORD cap)
{
    char pattern[64];
    DWORD i, p_len;
    const char *hit;

    StringCchPrintfA(pattern, sizeof pattern, "\"%s\"", key);
    p_len = (DWORD)strlen(pattern);
    if (from >= len) return FALSE;

    hit = NULL;
    for (i = from; i + p_len <= len; i++) {
        if (memcmp(json + i, pattern, p_len) == 0) {
            hit = json + i + p_len;
            break;
        }
    }
    if (!hit) return FALSE;

    while (hit < json + len && *hit != ':') {
        if (*hit == ',' || *hit == '}') return FALSE;
        hit++;
    }
    if (hit >= json + len) return FALSE;
    hit++;
    while (hit < json + len && (*hit == ' ' || *hit == '\t' || *hit == '\r' || *hit == '\n')) hit++;
    if (hit >= json + len || *hit != '"') return FALSE;
    hit++;

    i = 0;
    while (hit < json + len && *hit != '"') {
        if (*hit == '\\') return FALSE; /* the manifest needs no escapes */
        if (i + 1 >= cap) return FALSE;
        out[i++] = *hit++;
    }
    if (hit >= json + len) return FALSE;
    out[i] = '\0';
    return TRUE;
}

static BOOL manifest_asset(const char *json, DWORD len, char *url, DWORD url_cap,
                           char *sha, DWORD sha_cap, char *build, DWORD build_cap)
{
    char pattern[64];
    DWORD i, p_len;
    DWORD from = 0;
    const char *hit = NULL;

    StringCchPrintfA(pattern, sizeof pattern, "\"%s\"", ASSET_KEY);
    p_len = (DWORD)strlen(pattern);
    for (i = 0; i + p_len <= len; i++) {
        if (memcmp(json + i, pattern, p_len) == 0) {
            from = i + p_len;
            hit = json + i;
            break;
        }
    }
    if (!hit) return FALSE;
    return json_string(json, len, from, "url", url, url_cap) &&
           json_string(json, len, from, "sha256", sha, sha_cap) &&
           json_string(json, len, from, "build", build, build_cap);
}

/* -------------------------------------------------------------- shortcuts */

static BOOL create_shortcut(const wchar_t *target, const wchar_t *workdir)
{
    PWSTR programs = NULL;
    IShellLinkW *link = NULL;
    IPersistFile *file = NULL;
    wchar_t lnk[BUFSZ];
    BOOL ok = FALSE;
    HRESULT hr;

    if (FAILED(SHGetKnownFolderPath(&FOLDERID_Programs, 0, NULL, &programs))) return FALSE;
    if (!path_join(programs, L"sure-mail.lnk", lnk, BUFSZ)) goto done;

    hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) goto done;

    if (FAILED(CoCreateInstance(&CLSID_ShellLink, NULL, CLSCTX_INPROC_SERVER,
                                &IID_IShellLinkW, (void **)&link))) {
        goto done;
    }
    link->lpVtbl->SetPath(link, target);
    link->lpVtbl->SetWorkingDirectory(link, workdir);
    link->lpVtbl->SetIconLocation(link, target, 0);
    link->lpVtbl->SetDescription(link, L"sure-mail — a mail client whose logic lives in one core");
    if (FAILED(link->lpVtbl->QueryInterface(link, &IID_IPersistFile, (void **)&file))) goto done;
    ok = SUCCEEDED(file->lpVtbl->Save(file, lnk, TRUE));

done:
    if (file) file->lpVtbl->Release(file);
    if (link) link->lpVtbl->Release(link);
    if (programs) CoTaskMemFree(programs);
    return ok;
}

/* ---------------------------------------------------------------- install */

static BOOL start_app(const wchar_t *target, const wchar_t *workdir)
{
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    wchar_t cmd[BUFSZ];

    ZeroMemory(&si, sizeof si);
    si.cb = sizeof si;
    ZeroMemory(&pi, sizeof pi);
    StringCchPrintfW(cmd, BUFSZ, L"\"%ls\"", target);
    /* Its own console: this window is about to close. */
    if (!CreateProcessW(target, cmd, NULL, NULL, FALSE, CREATE_NEW_CONSOLE,
                        NULL, workdir, &si, &pi)) {
        return FALSE;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return TRUE;
}

static int install_verified(const wchar_t *payload, const wchar_t *dir,
                            const wchar_t *expected_sha, BOOL launch, BOOL shortcut,
                            BOOL consume)
{
    wchar_t target[BUFSZ], backup[BUFSZ], got[65];
    wchar_t err[BUFSZ];

    if (!dir_create(dir)) {
        describe(GetLastError(), err, BUFSZ);
        return fail(L"cannot create %ls: %ls", dir, err);
    }
    if (!path_join(dir, L"sure-mail.exe", target, BUFSZ)) return fail(L"install path is too long");
    if (!path_join(dir, L"sure-mail.exe.old", backup, BUFSZ)) return fail(L"install path is too long");

    msg(L"  verifying the download\n");
    if (!file_sha256(payload, got, err, BUFSZ)) {
        return fail(L"cannot check the downloaded file: %ls", err);
    }
    if (_wcsicmp(got, expected_sha) != 0) {
        return fail(L"the download does not match its published checksum.\n\n"
                    L"expected %ls\ngot      %ls\n\n"
                    L"Nothing was installed. Try again; if it repeats, the download "
                    L"is being altered in transit.", expected_sha, got);
    }

    msg(L"  installing to %ls\n", dir);
    if (GetFileAttributesW(target) != INVALID_FILE_ATTRIBUTES) {
        /* A running image cannot be overwritten, but it can be renamed — which
           is also how the payload's own updater swaps itself. */
        DeleteFileW(backup);
        if (!MoveFileExW(target, backup, MOVEFILE_REPLACE_EXISTING)) {
            describe(GetLastError(), err, BUFSZ);
            return fail(L"cannot replace %ls: %ls\n\n"
                        L"If sure-mail is running, close it and run this again.", target, err);
        }
    }
    {
        BOOL placed;
        if (consume) {
            /* Our own temporary download: moving it costs nothing. */
            placed = MoveFileExW(payload, target, MOVEFILE_REPLACE_EXISTING) != 0;
            if (!placed) placed = CopyFileW(payload, target, TRUE) && DeleteFileW(payload);
        } else {
            /* A file the user pointed at is theirs; copy, never consume. */
            placed = CopyFileW(payload, target, TRUE) != 0;
        }
        if (!placed) {
            describe(GetLastError(), err, BUFSZ);
            /* Put the previous build back rather than leave the user with none. */
            if (GetFileAttributesW(backup) != INVALID_FILE_ATTRIBUTES) {
                MoveFileExW(backup, target, MOVEFILE_REPLACE_EXISTING);
            }
            return fail(L"cannot install to %ls: %ls", target, err);
        }
    }

    /* The bytes on disk are what will run: check them again, not the temp copy. */
    if (!file_sha256(target, got, err, BUFSZ) || _wcsicmp(got, expected_sha) != 0) {
        if (GetFileAttributesW(backup) != INVALID_FILE_ATTRIBUTES) {
            DeleteFileW(target);
            MoveFileExW(backup, target, MOVEFILE_REPLACE_EXISTING);
        }
        return fail(L"the installed file does not match its checksum.\n\n"
                    L"Previous build restored. The disk may be failing.");
    }

    msg(L"  installed %ls\n", target);
    if (shortcut) {
        if (create_shortcut(target, dir)) msg(L"  added a Start Menu shortcut\n");
        else msg(L"  (could not add a Start Menu shortcut; the app still works)\n");
    }

    if (launch) {
        msg(L"  starting it\n");
        if (!start_app(target, dir)) {
            describe(GetLastError(), err, BUFSZ);
            return fail(L"installed, but could not start %ls: %ls", target, err);
        }
        msg(L"\nsure-mail is starting. Its console window has to stay open while you\n"
            L"use the client — closing it closes the client.\n");
    }
    return 0;
}

/* ------------------------------------------------------------------- main */

static void usage(void)
{
    wprintf(L"sure-mail setup " L"0.1.0" L" — installs the latest build.\n\n"
            L"  --payload <file>   install from a local file (offline)\n"
            L"  --sha256 <hex>     the file's expected SHA-256 (required with --payload)\n"
            L"  --url <url>        download from this URL instead of the manifest\n"
            L"  --manifest <url>   manifest to read (default: the published one)\n"
            L"  --dir <path>       install directory (default: %%LOCALAPPDATA%%\\Programs\\sure-mail)\n"
            L"  --no-launch        install only\n"
            L"  --no-shortcut      do not create a Start Menu shortcut\n"
            L"  --quiet            only errors\n"
            L"  --version          print the setup version\n");
}

static int default_dir(wchar_t *out, DWORD cap)
{
    PWSTR local = NULL;
    int rc = 1;
    if (SUCCEEDED(SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, NULL, &local))) {
        if (SUCCEEDED(StringCchPrintfW(out, cap, L"%ls\\Programs\\sure-mail", local))) rc = 0;
        CoTaskMemFree(local);
    }
    return rc;
}

static int mkmain(int argc, wchar_t **argv)
{
    wchar_t *payload = NULL, *url = NULL, *sha = NULL, *dir = NULL;
    wchar_t manifest[BUFSZ];
    wchar_t temp[BUFSZ];
    wchar_t err[BUFSZ];
    wchar_t installed_dir[BUFSZ];
    BOOL launch = TRUE, shortcut = TRUE;
    char *json = NULL;
    DWORD json_len = 0;
    char asset_url[2048], asset_sha[128], asset_build[64];
    wchar_t wide_url[2048], wide_sha[128];
    int i, rc;

    StringCchCopyW(manifest, BUFSZ, DEFAULT_MANIFEST);

    for (i = 1; i < argc; i++) {
        const wchar_t *a = argv[i];
        const wchar_t *value = (i + 1 < argc) ? argv[i + 1] : NULL;
        if (!wcscmp(a, L"--help") || !wcscmp(a, L"-h")) { usage(); return 0; }
        if (!wcscmp(a, L"--version")) { wprintf(L"sure-mail setup " L"0.1.0" L"\n"); return 0; }
        if (!wcscmp(a, L"--no-launch")) { launch = FALSE; continue; }
        if (!wcscmp(a, L"--no-shortcut")) { shortcut = FALSE; continue; }
        if (!wcscmp(a, L"--quiet")) { g_quiet = TRUE; continue; }
        if (!wcscmp(a, L"--payload") && value) { payload = argv[++i]; continue; }
        if (!wcscmp(a, L"--url") && value) { url = argv[++i]; continue; }
        if (!wcscmp(a, L"--sha256") && value) { sha = argv[++i]; continue; }
        if (!wcscmp(a, L"--manifest") && value) { StringCchCopyW(manifest, BUFSZ, argv[++i]); continue; }
        if (!wcscmp(a, L"--dir") && value) { dir = argv[++i]; continue; }
        fwprintf(stderr, L"sure-mail setup: unknown option %ls\n\n", a);
        usage();
        return 2;
    }

    if (dir) {
        if (!*dir) return fail(L"--dir needs a path");
        StringCchCopyW(installed_dir, BUFSZ, dir);
    } else if (default_dir(installed_dir, BUFSZ) != 0) {
        return fail(L"cannot find %%LOCALAPPDATA%%");
    }

    if (payload && !sha) {
        return fail(L"--payload also needs --sha256 — a file that arrives without a "
                    L"checksum is a file nobody verified.");
    }
    if (url && !sha) {
        return fail(L"--url also needs --sha256, for the same reason.");
    }

    msg(L"sure-mail setup %ls\n", L"0.1.0");

    if (payload) {
        if (GetFileAttributesW(payload) == INVALID_FILE_ATTRIBUTES) {
            return fail(L"no such file: %ls", payload);
        }
        msg(L"  installing from %ls\n", payload);
        return install_verified(payload, installed_dir, sha, launch, shortcut, FALSE);
    }

    if (!url) {
        msg(L"  reading %ls\n", manifest);
        if (!http_get(manifest, NULL, &json, &json_len, err, BUFSZ)) {
            return fail(L"cannot read the update manifest:\n%ls", err);
        }
        if (!manifest_asset(json, json_len, asset_url, sizeof asset_url,
                            asset_sha, sizeof asset_sha, asset_build, sizeof asset_build)) {
            free(json);
            return fail(L"the manifest has no build for this machine (win32-x64).");
        }
        free(json);
        MultiByteToWideChar(CP_UTF8, 0, asset_url, -1, wide_url, 2048);
        MultiByteToWideChar(CP_UTF8, 0, asset_sha, -1, wide_sha, 128);
        url = wide_url;
        sha = wide_sha;
        {
            wchar_t wide_build[64];
            MultiByteToWideChar(CP_UTF8, 0, asset_build, -1, wide_build, 64);
            msg(L"  latest build %ls\n", wide_build);
        }
    }

    {
        wchar_t tmpdir[BUFSZ], name[64];
        if (!GetTempPathW(BUFSZ, tmpdir)) return fail(L"cannot find a temporary directory");
        StringCchPrintfW(name, 64, L"sure-mail-%lu.exe", (unsigned long)GetCurrentProcessId());
        if (!path_join(tmpdir, name, temp, BUFSZ)) return fail(L"temporary path is too long");
    }
    DeleteFileW(temp);

    msg(L"  downloading %ls\n", url);
    if (!http_get(url, temp, NULL, NULL, err, BUFSZ)) {
        DeleteFileW(temp);
        return fail(L"the download failed:\n%ls\n\nThe installed build, if any, was not touched.", err);
    }

    rc = install_verified(temp, installed_dir, sha, launch, shortcut, TRUE);
    DeleteFileW(temp);
    return rc;
}

int wmain(int argc, wchar_t **argv)
{
    int rc = mkmain(argc, argv);
    if (rc != 0 && !g_quiet) {
        /* Keep a double-clicked window readable long enough to copy the message. */
        fwprintf(stderr, L"\nPress Enter to close.\n");
        getwchar();
    }
    return rc;
}
