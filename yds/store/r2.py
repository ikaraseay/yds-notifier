"""R2 状态对象存储（Cloudflare REST API）。

为什么需要：运行状态原先靠 `git commit` 在两次 Actions 之间传递 —— 会冲突、
会污染历史、`ai.json` 572 KB 永久留在仓库里。R2 只有 PUT/GET/LIST，
把状态从仓库搬出去，跨机器共享也只需一个桶。

设计要点：
- **一个凭据**：只用账户级 `CLOUDFLARE_API_TOKEN`（Workers R2 Storage Read/Write），
  不再需要 R2 的 Access Key / Secret；请求走 `api.cloudflare.com`。
- **对上层透明**：本地仍然读写普通 JSON 文件（`data/*.json`），这里负责在运行
  开始前把它们拉下来、结束后上传回去。业务代码完全不知道对象存储存在。
- **gzip 存储**：本地明文、远端压缩，572 KB → 166 KB；
  `mtime=0` 保证同样的内容压缩结果稳定，便于用哈希判断"是否真的变了"。
- **按对象拆分**：一个逻辑状态一个 key，某个对象损坏不会拖垮其余状态。
- **客户端可注入**：测试用假 client，不联网。
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Dict, Optional

log = logging.getLogger("yds")

# 一个逻辑状态一个对象：部分损坏 / 部分失败不会互相牵连
STATE_FILES = (
    "seen.json",
    "ai.json",
    "pending.json",
    "schedule.json",
    "reminders.json",
    "zones.json",  # 赛事状态 AI 判定缓存（v2），每个正常运行的轮次都会读写，勿删
)

_GZIP_MAGIC = b"\x1f\x8b"
_API = "https://api.cloudflare.com/client/v4"


class StateConflict(RuntimeError):
    """条件写失败：远端已被别的运行改过（ETag 已变化）。"""


class StateUnavailable(RuntimeError):
    """配了 R2 却读不到状态（网络 / 权限 / 桶名错）。

    这种情况必须中止运行：本地文件可能是仓库里的陈旧副本，
    拿它当基线会把这些天推过的通知全部再发一遍。
    """


class _RestError(Exception):
    def __init__(self, status: int, message: str, code: object = None):
        self.status = status
        self.code = code
        super().__init__(f"HTTP {status}: {message}")


class _RestClient:
    """最小 R2 REST 客户端：list / get / put，鉴权只用账户级 API Token。"""

    def __init__(self, account_id: str, api_token: str, bucket: str, timeout: int = 30):
        self.bucket = bucket
        self.timeout = timeout
        self.base = (
            f"{_API}/accounts/{account_id}/r2/buckets/"
            f"{urllib.parse.quote(bucket, safe='')}/objects"
        )
        self._headers = {"Authorization": f"Bearer {api_token}"}

    def _request(self, method: str, key: str = "", params=None, body=None, headers=None):
        url = self.base + (f"/{urllib.parse.quote(key, safe='/')}" if key else "")
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(
            url, data=body, method=method, headers={**self._headers, **(headers or {})}
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            message, code = raw[:200].decode("utf-8", "replace"), None
            try:
                errors = (json.loads(raw) or {}).get("errors") or []
                if errors:
                    code = errors[0].get("code")
                    message = "；".join(str(e.get("message") or "") for e in errors)
            except ValueError:
                pass
            raise _RestError(exc.code, message, code) from exc
        except OSError as exc:
            raise _RestError(0, str(exc)) from exc

    def list_objects(self, prefix: str = "") -> list[dict]:
        out: list[dict] = []
        cursor = None
        while True:
            params = {"prefix": prefix, "per_page": 1000}
            if cursor:
                params["cursor"] = cursor
            _, _, raw = self._request("GET", params=params)
            payload = json.loads(raw)
            out.extend(payload.get("result") or [])
            info = payload.get("result_info") or {}
            if not info.get("is_truncated"):
                break
            cursor = info.get("cursor")
            if not cursor:
                break
        return out

    def get_object(self, key: str) -> dict:
        _, headers, body = self._request("GET", key=key)
        return {"Body": io.BytesIO(body), "ETag": (headers.get("ETag") or "").strip('"')}

    def put_object(self, key: str, body: bytes, etag: str = "") -> dict:
        if etag:
            # REST 的 PutObject 不支持原子 If-Match；先做一次条件读取，
            # ETag 变了就按冲突处理（并发窗口极小，Actions 还另有 concurrency 约束）。
            try:
                self._request("GET", key=key, headers={"If-None-Match": f'"{etag}"'})
            except _RestError as exc:
                if exc.status == 304:
                    pass
                elif exc.status == 404:
                    raise StateConflict(f"{key} 已被其他运行删除") from exc
                else:
                    raise
            else:
                raise StateConflict(f"{key} 已被其他运行修改（ETag 不匹配）")
        _, headers, _ = self._request(
            "PUT",
            key=key,
            body=body,
            headers={"Content-Type": "application/json", "Content-Encoding": "gzip"},
        )
        return {"ETag": (headers.get("ETag") or "").strip('"')}


class R2StateStore:
    def __init__(
        self,
        bucket: str,
        account_id: str = "",
        api_token: str = "",
        prefix: str = "state",
        client=None,
    ):
        self.bucket = bucket
        self.account_id = account_id
        self.prefix = (prefix or "state").strip("/")
        self._client = client
        self._credentials = (account_id, api_token)
        # 拉取时记下远端的 ETag 与内容哈希，push 时用于冲突检测与"跳过未变对象"
        self._etags: Dict[str, str] = {}
        self._hashes: Dict[str, str] = {}
        self._ready = False  # 远端是否已初始化过（见 _ready_key）

    # ------------------------------------------------------------------ 基础
    @property
    def client(self):
        """延迟创建的 REST 客户端（运维脚本用；业务代码只走 pull/push）。"""
        return self._get_client()

    @property
    def enabled(self) -> bool:
        """有 bucket 且有客户端或完整凭证才算可用（客户端可延迟创建）。"""
        if not self.bucket:
            return False
        if self._client is not None:
            return True
        return all(self._credentials)

    def _get_client(self):
        if self._client is not None:
            return self._client
        account, token = self._credentials
        if not (account and token):
            return None
        self._client = _RestClient(account, token, self.bucket)
        return self._client

    def key_of(self, name: str) -> str:
        return f"{self.prefix}/{name}.gz" if self.prefix else f"{name}.gz"

    def _ready_key(self) -> str:
        return f"{self.prefix}/_ready.json" if self.prefix else "_ready.json"

    def list_objects(self) -> list[dict]:
        """列出前缀下的对象，字段保持运维脚本使用的 Key / Size / LastModified。"""
        client = self._get_client()
        if client is None:
            raise StateUnavailable("R2 已配置但客户端不可用（检查 CLOUDFLARE_API_TOKEN）")
        prefix = (self.prefix + "/") if self.prefix else ""
        return [
            {
                "Key": obj.get("key"),
                "Size": obj.get("size") or 0,
                "LastModified": obj.get("last_modified"),
            }
            for obj in client.list_objects(prefix)
        ]

    def read_object(self, name: str) -> bytes:
        """读一个状态对象的原始字节；不存在时抛 FileNotFoundError。"""
        client = self._get_client()
        if client is None:
            raise StateUnavailable("R2 已配置但客户端不可用（检查 CLOUDFLARE_API_TOKEN）")
        try:
            return client.get_object(self.key_of(name))["Body"].read()
        except _RestError as exc:
            if _is_missing(exc):
                raise FileNotFoundError(self.key_of(name)) from exc
            raise

    # ------------------------------------------------------------------ 读
    def pull(self, data_dir: str, names=STATE_FILES) -> int:
        """把远端对象写成本地文件，返回成功拉取的个数。

        - 对象不存在（首次运行）→ 跳过，不算错误；
        - 网络 / 权限 / 桶名错误 → 收集后抛 `StateUnavailable`，
          由调用方中止运行（绝不能拿陈旧本地状态当基线，那会重复群发）。
        """
        client = self._get_client()
        if client is None:
            raise StateUnavailable("R2 已配置但客户端不可用（检查 CLOUDFLARE_API_TOKEN）")
        os.makedirs(data_dir, exist_ok=True)
        got = 0
        failures = []
        # 初始化标记：区分"桶里本来就没有状态"（首次运行，可用仓库里的基线）
        # 与"曾经有、现在没了"（桶被清空 / 前缀写错 —— 必须中止，否则全量重发）
        try:
            client.get_object(self._ready_key())
            self._ready = True
        except Exception as exc:  # noqa: BLE001
            if not _is_missing(exc):
                failures.append(f"{self._ready_key()}: {str(exc)[:120]}")
        for name in names:
            key = self.key_of(name)
            try:
                obj = client.get_object(key)
                body = obj["Body"].read()
                etag = str(obj.get("ETag") or "").strip('"')
            except Exception as exc:  # noqa: BLE001
                if _is_missing(exc):
                    log.debug("R2 无 %s（首次运行或该状态尚未生成）", key)
                else:
                    failures.append(f"{key}: {str(exc)[:120]}")
                continue
            raw = gzip.decompress(body) if body[:2] == _GZIP_MAGIC else body
            tmp = os.path.join(data_dir, name + ".r2tmp")
            os.makedirs(os.path.dirname(tmp) or ".", exist_ok=True)
            with open(tmp, "wb") as fh:
                fh.write(raw)
            os.replace(tmp, os.path.join(data_dir, name))
            self._etags[name] = etag
            self._hashes[name] = hashlib.sha256(body).hexdigest()
            got += 1
        if failures:
            raise StateUnavailable("；".join(failures[:3]))
        if got == 0 and self._ready:
            # 标记还在、状态全没了：绝不能把仓库里的陈旧 data/*.json 当基线
            raise StateUnavailable(
                "远端有初始化标记但状态对象全部缺失（桶被清空或前缀写错？）"
            )
        return got

    # ------------------------------------------------------------------ 写
    def push(self, data_dir: str, names=STATE_FILES) -> Dict[str, str]:
        """上传有变化的本地文件。返回 {"uploaded": [...], "skipped": [...]}。"""
        client = self._get_client()
        result = {"uploaded": [], "skipped": [], "missing": []}
        if client is None:
            return result
        for name in names:
            path = os.path.join(data_dir, name)
            if not os.path.exists(path):
                result["missing"].append(name)
                continue
            with open(path, "rb") as fh:
                raw = fh.read()
            body = gzip.compress(raw, mtime=0)
            digest = hashlib.sha256(body).hexdigest()
            if self._hashes.get(name) == digest:
                result["skipped"].append(name)  # 内容没变，一次写操作都不花
                continue
            key = self.key_of(name)
            resp = client.put_object(key, body, etag=self._etags.get(name, ""))
            new_etag = str((resp or {}).get("ETag") or "").strip('"')
            if new_etag:
                self._etags[name] = new_etag
            self._hashes[name] = digest
            result["uploaded"].append(name)
            log.info("R2 已上传 %s（%.1f KB）", key, len(body) / 1024)
        if not self._ready:
            # 首次写回：落下初始化标记，今后"状态全丢"能被识别出来
            try:
                client.put_object(self._ready_key(), b'{"version":1}')
                self._ready = True
            except Exception as exc:  # noqa: BLE001 - 标记失败不阻断本轮
                log.warning("R2 初始化标记写入失败：%s", str(exc)[:120])
        return result


def _is_missing(exc: Exception) -> bool:
    if isinstance(exc, _RestError):
        return exc.status == 404 or exc.code in (10007, 10008)
    text = str(exc)
    return "NoSuchKey" in text or "404" in text or "Not Found" in text


def build_store(settings, client=None) -> Optional[R2StateStore]:
    """按配置构造存储；缺任何一项都返回 None（=继续用本地文件 / git）。"""
    backend = (getattr(settings, "state_backend", "auto") or "auto").lower()
    if backend in ("local", "git", "off"):
        return None
    bucket = getattr(settings, "r2_bucket", "") or ""
    if not bucket:
        return None
    account = getattr(settings, "cloudflare_account_id", "") or ""
    token = getattr(settings, "cloudflare_api_token", "") or ""
    if backend != "r2" and not (account and token):
        return None  # auto 模式下凭证不全就当没配
    store = R2StateStore(
        bucket=bucket,
        account_id=account,
        api_token=token,
        prefix=getattr(settings, "r2_prefix", "state") or "state",
        client=client,
    )
    return store if store.enabled else None
