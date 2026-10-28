"""VPFM 工作台扩展：装进内置的 FlowMap 服务器（同一个本地端口）。

- ``/wb/``：外壳界面和各模块的静态文件（安装目录下的 ``wb`` 文件夹），``/`` 跳到 ``/wb/``；
- ``/api/wb/proxy/<完整网址>``：交易所公开 REST 接口的本地转发，解决网页跨域，并走代理；
- ``/api/wb/info`` ``/api/wb/settings`` ``/api/wb/update-check`` ``/api/wb/open``
  ``/api/wb/apps`` ``/api/wb/launch`` ``/api/wb/open-data``：外壳用的辅助接口；
- 启动时读取系统代理（Windows 注册表）或设置里的自定义代理，写进环境变量，并让
  aiohttp 会话一律 ``trust_env=True``，这样内置服务器自己的行情连接（REST 和 WebSocket）
  也走代理。

只接受本机同源页面的请求（浏览器带的 Origin / Sec-Fetch-Site 不是本服务就拒绝），
转发目标只允许公网 http(s) 地址。
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import mimetypes
import os
import ssl
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import aiohttp
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.staticfiles import StaticFiles

SETTINGS_FILE = "vpfm-settings.json"
PROXY_FILE = "vpfm-proxy.txt"
FLAG_FILE = "vpfm-update.flag"
PROXY_PREFIX = "/api/wb/proxy/"
FUPANBOOK_RELEASES = "https://github.com/gouqizi2214730-source/trade-journal/releases"

_ORIG_ENV = {k.lower(): v for k, v in os.environ.items() if k.lower().endswith("_proxy")}
_state: dict = {"proxy": "", "source": "none", "session": None, "session_proxy": None}
_started = time.time()


# ---------------------------------------------------------------- 设置与代理
def _data_dir() -> Path:
    # 桌面版把内置服务器的工作目录设为应用数据目录
    return Path.cwd()


def load_settings() -> dict:
    try:
        d = json.loads((_data_dir() / SETTINGS_FILE).read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_settings(d: dict) -> None:
    p = _data_dir() / SETTINGS_FILE
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)


def _norm_proxy(u: str) -> str:
    u = (u or "").strip()
    if not u:
        return ""
    if "://" not in u:
        u = "http://" + u
    return u if u.lower().startswith(("http://", "https://")) else ""


def detect_proxy(settings: dict | None = None) -> tuple[str, str]:
    """返回 (代理地址, 来源)。来源：custom / env / system / off / none / unsupported。"""
    s = load_settings() if settings is None else settings
    mode = s.get("proxyMode", "system")
    if mode == "off":
        return "", "off"
    if mode == "custom":
        u = _norm_proxy(s.get("proxy", ""))
        return (u, "custom") if u else ("", "none")
    u = _ORIG_ENV.get("https_proxy") or _ORIG_ENV.get("http_proxy") or _ORIG_ENV.get("all_proxy") or ""
    if u:
        n = _norm_proxy(u)
        return (n, "env") if n else ("", "unsupported")
    if sys.platform == "win32":
        try:
            reg = urllib.request.getproxies_registry()
        except Exception:  # noqa: BLE001 — 注册表读不了就当没有代理
            reg = {}
        u = reg.get("https") or reg.get("http") or ""
        if u:
            n = _norm_proxy(u)
            return (n, "system") if n else ("", "unsupported")
    return "", "none"


def apply_proxy(settings: dict | None = None) -> None:
    u, src = detect_proxy(settings)
    for k in ("http_proxy", "https_proxy", "ws_proxy", "wss_proxy"):
        for kk in {k, k.upper()}:
            if u:
                os.environ[kk] = u
            else:
                os.environ.pop(kk, None)
    os.environ["no_proxy"] = "localhost,127.0.0.1,::1"
    if sys.platform != "win32":
        os.environ["NO_PROXY"] = os.environ["no_proxy"]
    _state.update(proxy=u, source=src)
    try:  # 给桌面外壳的更新下载用
        (_data_dir() / PROXY_FILE).write_text(u, encoding="utf-8")
    except OSError:
        pass


def _force_trust_env() -> None:
    """所有 aiohttp 会话都读取代理环境变量（行情库默认不读）。"""
    orig = aiohttp.ClientSession.__init__
    if getattr(orig, "_vpfm", False):
        return

    def init(self, *args, **kwargs):
        kwargs["trust_env"] = True
        orig(self, *args, **kwargs)

    init._vpfm = True  # type: ignore[attr-defined]
    aiohttp.ClientSession.__init__ = init  # type: ignore[method-assign]


def _fix_mimetypes() -> None:
    # Windows 注册表常把 .js 记成 text/plain，模块脚本会被浏览器拒绝加载
    mimetypes.init()
    for ext, typ in {
        ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
        ".json": "application/json", ".map": "application/json", ".wasm": "application/wasm",
        ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
        ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
        ".png": "image/png", ".ico": "image/x-icon", ".html": "text/html",
        ".txt": "text/plain", ".mp3": "audio/mpeg", ".wav": "audio/wav",
    }.items():
        mimetypes.add_type(typ, ext)


# ---------------------------------------------------------------- 安全检查
def _same_origin(request: Request) -> bool:
    origin = request.headers.get("origin")
    if origin:
        try:
            o = urllib.parse.urlsplit(origin)
        except ValueError:
            return False
        if o.scheme != "http" or (o.hostname or "") not in ("127.0.0.1", "localhost", "::1"):
            return False
        host = request.headers.get("host", "")
        return o.netloc == host or (o.port is not None and o.port == request.url.port)
    site = request.headers.get("sec-fetch-site")
    return site in (None, "", "same-origin", "none")


def _public_target(raw: str, query: str) -> str | None:
    raw = raw.lstrip("/")
    low = raw[:8].lower()
    if low.startswith(("http:/", "https:/")) and not low.startswith(("http://", "https://")):
        raw = raw.replace(":/", "://", 1)  # 个别客户端会把 // 合并成 /
    if not raw.lower().startswith(("http://", "https://")):
        return None
    if query:
        raw += ("&" if "?" in raw else "?") + query
    try:
        u = urllib.parse.urlsplit(raw)
    except ValueError:
        return None
    host = (u.hostname or "").lower().rstrip(".")
    if not host or host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".lan")):
        return None
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return raw
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
        return None
    return raw


def _forbidden() -> JSONResponse:
    return JSONResponse({"error": {"code": "forbidden", "message": "只接受本机 VPFM 页面的请求"}}, status_code=403)


# ---------------------------------------------------------------- 转发
def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:  # noqa: BLE001
        return ssl.create_default_context()


async def _session() -> aiohttp.ClientSession:
    s = _state.get("session")
    if s is not None and not s.closed and _state.get("session_proxy") == _state["proxy"]:
        return s
    if s is not None and not s.closed:
        old = s
        asyncio.get_running_loop().call_later(30, lambda: asyncio.ensure_future(old.close()))
    s = aiohttp.ClientSession(
        trust_env=True,
        timeout=aiohttp.ClientTimeout(total=30, connect=12, sock_read=25),
        connector=aiohttp.TCPConnector(limit=48, limit_per_host=10, ttl_dns_cache=300, ssl=_ssl_context()),
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) VPFM/2"},
        auto_decompress=True,
    )
    _state.update(session=s, session_proxy=_state["proxy"])
    return s


_FORWARD_REQ = ("content-type", "accept", "accept-language")
_FORWARD_RESP = ("content-type", "retry-after", "x-mbx-used-weight-1m", "x-bapi-limit-status", "x-ratelimit-remaining")


async def proxy(request: Request) -> Response:
    if not _same_origin(request):
        return _forbidden()
    raw = request.scope.get("raw_path", b"").decode("latin-1")
    rest = raw[len(PROXY_PREFIX):] if raw.startswith(PROXY_PREFIX) else request.path_params.get("target", "")
    target = _public_target(rest, request.url.query)
    if target is None:
        return JSONResponse({"error": {"code": "bad_target", "message": "只能转发公网 http(s) 地址"}}, status_code=400)
    body = await request.body() if request.method in ("POST", "PUT", "PATCH", "DELETE") else None
    headers = {k: v for k, v in request.headers.items() if k.lower() in _FORWARD_REQ}
    try:
        sess = await _session()
        async with sess.request(request.method, target, data=body, headers=headers, allow_redirects=True) as r:
            data = await r.read()
            out = {k: v for k, v in r.headers.items() if k.lower() in _FORWARD_RESP}
            out["Cache-Control"] = "no-store"
            return Response(content=data, status_code=r.status, headers=out)
    except asyncio.TimeoutError:
        return JSONResponse({"error": {"code": "timeout", "message": f"连接超时：{urllib.parse.urlsplit(target).hostname}"}}, status_code=504)
    except aiohttp.ClientError as e:
        hint = "（当前未使用代理）" if not _state["proxy"] else f"（代理 {_state['proxy']}）"
        return JSONResponse({"error": {"code": "upstream", "message": f"{type(e).__name__}: {e} {hint}"}}, status_code=502)


# ---------------------------------------------------------------- 辅助接口
def _wb_dir() -> Path | None:
    cands: list[Path] = []
    if os.environ.get("VPFM_WB_DIR"):
        cands.append(Path(os.environ["VPFM_WB_DIR"]))
    exe = Path(sys.executable).resolve()
    for base in (exe.parent, exe.parent.parent, exe.parents[2] if len(exe.parents) > 2 else exe.parent):
        cands += [base / "wb", base / "resources" / "wb", base / "Resources" / "wb"]
    for c in cands:
        if (c / "index.html").is_file():
            return c
    return None


def _read_version(wb: Path | None) -> dict:
    if wb is None:
        return {}
    try:
        return json.loads((wb / "version.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _find_fupanbook() -> str | None:
    cands = []
    for env, sub in (("LOCALAPPDATA", r"Programs\FupanBook"), ("PROGRAMFILES", "FupanBook"), ("PROGRAMFILES(X86)", "FupanBook")):
        if os.environ.get(env):
            cands.append(Path(os.environ[env]) / sub / "FupanBook.exe")
    for c in cands:
        if c.is_file():
            return str(c)
    if sys.platform == "win32":  # 安装到别处时从卸载信息里找
        try:
            import winreg

            for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
                try:
                    k = winreg.OpenKey(root, r"Software\Microsoft\Windows\CurrentVersion\Uninstall")
                except OSError:
                    continue
                for i in range(winreg.QueryInfoKey(k)[0]):
                    try:
                        sk = winreg.OpenKey(k, winreg.EnumKey(k, i))
                        name = str(winreg.QueryValueEx(sk, "DisplayName")[0])
                        if not (name.startswith("FupanBook") or name.startswith("复盘本")):
                            continue
                        loc = str(winreg.QueryValueEx(sk, "InstallLocation")[0])
                        exe = Path(loc) / "FupanBook.exe"
                        if exe.is_file():
                            return str(exe)
                    except OSError:
                        continue
        except Exception:  # noqa: BLE001
            pass
    return None


def _open_external(target: str) -> None:
    if sys.platform == "win32":
        os.startfile(target)  # type: ignore[attr-defined]  # noqa: S606
    elif sys.platform == "darwin":
        subprocess.Popen(["open", target])  # noqa: S603,S607
    else:
        subprocess.Popen(["xdg-open", target])  # noqa: S603,S607


def _detached(exe: str) -> None:
    kw: dict = {"cwd": str(Path(exe).parent), "close_fds": True}
    if sys.platform == "win32":
        kw["creationflags"] = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    subprocess.Popen([exe], **kw)  # noqa: S603


async def _json_body(request: Request) -> dict:
    try:
        d = await request.json()
        return d if isinstance(d, dict) else {}
    except ValueError:
        return {}


def install(app: FastAPI) -> None:
    """把工作台路由挂到 FlowMap 服务器上（由 api/app.py 调用）。"""
    _fix_mimetypes()
    wb = _wb_dir()

    async def root() -> RedirectResponse:
        return RedirectResponse("/wb/", status_code=307)

    async def info() -> JSONResponse:
        return JSONResponse({
            "app": "VPFM", "build": _read_version(wb), "wbDir": str(wb) if wb else None,
            "proxy": _state["proxy"], "proxySource": _state["source"], "dataDir": str(_data_dir()),
            "python": sys.version.split()[0], "platform": sys.platform, "uptime": round(time.time() - _started),
        }, headers={"Cache-Control": "no-store"})

    async def get_settings() -> JSONResponse:
        s = load_settings()
        return JSONResponse({"proxyMode": s.get("proxyMode", "system"), "proxy": s.get("proxy", ""),
                             "effective": _state["proxy"], "source": _state["source"]})

    async def post_settings(request: Request) -> JSONResponse:
        if not _same_origin(request):
            return _forbidden()
        body = await _json_body(request)
        s = load_settings()
        mode = body.get("proxyMode", s.get("proxyMode", "system"))
        if mode not in ("system", "custom", "off"):
            return JSONResponse({"error": {"code": "bad_request", "message": "proxyMode 只能是 system/custom/off"}}, status_code=400)
        s["proxyMode"] = mode
        if "proxy" in body:
            p = str(body.get("proxy") or "").strip()
            if p and not _norm_proxy(p):
                return JSONResponse({"error": {"code": "bad_request", "message": "代理地址需要是 http://主机:端口"}}, status_code=400)
            s["proxy"] = p
        _save_settings(s)
        apply_proxy(s)
        return JSONResponse({"ok": True, "effective": _state["proxy"], "source": _state["source"]})

    async def update_check(request: Request) -> JSONResponse:
        if not _same_origin(request):
            return _forbidden()
        (_data_dir() / FLAG_FILE).write_text(str(time.time()), encoding="utf-8")
        return JSONResponse({"ok": True})

    async def open_url(request: Request) -> JSONResponse:
        if not _same_origin(request):
            return _forbidden()
        url = str((await _json_body(request)).get("url", ""))
        if not url.lower().startswith(("http://", "https://")):
            return JSONResponse({"error": {"code": "bad_request", "message": "只能打开网址"}}, status_code=400)
        try:
            _open_external(url)
        except OSError as e:
            return JSONResponse({"error": {"code": "open_failed", "message": str(e)}}, status_code=500)
        return JSONResponse({"ok": True})

    async def apps() -> JSONResponse:
        return JSONResponse({"fupanbook": {"path": _find_fupanbook(), "download": FUPANBOOK_RELEASES}})

    async def launch(request: Request) -> JSONResponse:
        if not _same_origin(request):
            return _forbidden()
        name = str((await _json_body(request)).get("app", ""))
        if name != "fupanbook":
            return JSONResponse({"error": {"code": "bad_request", "message": "未知程序"}}, status_code=400)
        exe = _find_fupanbook()
        if not exe:
            return JSONResponse({"ok": False, "reason": "not-installed", "download": FUPANBOOK_RELEASES})
        try:
            _detached(exe)
        except OSError as e:
            return JSONResponse({"error": {"code": "launch_failed", "message": f"启动失败：{e}"}}, status_code=500)
        return JSONResponse({"ok": True, "path": exe})

    async def open_data(request: Request) -> JSONResponse:
        if not _same_origin(request):
            return _forbidden()
        try:
            _open_external(str(_data_dir()))
        except OSError as e:
            return JSONResponse({"error": {"code": "open_failed", "message": str(e)}}, status_code=500)
        return JSONResponse({"ok": True})

    async def wb_noslash() -> RedirectResponse:
        return RedirectResponse("/wb/", status_code=307)

    async def missing(rest: str = "") -> HTMLResponse:
        return HTMLResponse("<meta charset=utf-8><body style='background:#0b1018;color:#ccd;font:15px sans-serif;padding:40px'>"
                            "<h2>没有找到 VPFM 界面文件</h2><p>安装目录里缺少 wb 文件夹，请重新安装 VPFM。</p>", status_code=404)

    app.add_api_route("/", root, methods=["GET"], include_in_schema=False)
    app.add_api_route("/wb", wb_noslash, methods=["GET"], include_in_schema=False)
    app.add_api_route(PROXY_PREFIX + "{target:path}", proxy, methods=["GET", "POST", "HEAD"], include_in_schema=False)
    app.add_api_route("/api/wb/info", info, methods=["GET"], include_in_schema=False)
    app.add_api_route("/api/wb/settings", get_settings, methods=["GET"], include_in_schema=False)
    app.add_api_route("/api/wb/settings", post_settings, methods=["POST"], include_in_schema=False)
    app.add_api_route("/api/wb/update-check", update_check, methods=["POST"], include_in_schema=False)
    app.add_api_route("/api/wb/open", open_url, methods=["POST"], include_in_schema=False)
    app.add_api_route("/api/wb/apps", apps, methods=["GET"], include_in_schema=False)
    app.add_api_route("/api/wb/launch", launch, methods=["POST"], include_in_schema=False)
    app.add_api_route("/api/wb/open-data", open_data, methods=["POST"], include_in_schema=False)
    if wb is not None:
        app.mount("/wb", _WbStatic(directory=str(wb), html=True), name="vpfm-wb")
    else:
        app.add_api_route("/wb/{rest:path}", missing, methods=["GET"], include_in_schema=False)


class _WbStatic(StaticFiles):
    """静态文件一律带 no-cache：升级后不会用到浏览器里的旧脚本（本机校验 ETag 很快）。"""

    def file_response(self, *args, **kwargs):  # type: ignore[override]
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


# 导入时就生效：在任何行情会话创建之前设置代理
apply_proxy()
_force_trust_env()
