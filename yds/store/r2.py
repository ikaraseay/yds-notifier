"""R2 状态对象存储（S3 兼容）。

为什么需要：运行状态原先靠 `git commit` 在两次 Actions 之间传递 —— 会冲突、
会污染历史、`ai.json` 572 KB 永久留在仓库里。R2 只有一个 PUT/GET，
并且支持 `If-Match` 条件写，可以真正防并发覆盖（比本地 flock 强，跨机器也有效）。

设计要点：
- **对上层透明**：本地仍然读写普通 JSON 文件（`data/*.json`），这里负责在运行
  开始前把它们拉下来、结束后上传回去。业务代码完全不知道对象存储存在。
- **gzip 存储**：本地明文、远端压缩，572 KB → 166 KB；
  `mtime=0` 保证同样的内容压缩结果稳定，便于用哈希判断"是否真的变了"。
- **按对象拆分**：一个逻辑状态一个 key，某个对象损坏不会拖垮其余状态。
- **客户端可注入**：测试用假 client，不联网、不依赖 boto3 是否安装。
"""

from __future__ import annotations

import gzip
import hashlib
import io
import logging
import os
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


class StateConflict(RuntimeError):
    """条件写失败：远端已被别的运行改过（If-Match 不匹配）。"""


class StateUnavailable(RuntimeError):
    """配了 R2 却读不到状态（网络 / 权限 / 桶名错）。

    这种情况必须中止运行：本地文件可能是仓库里的陈旧副本，
    拿它当基线会把这些天推过的通知全部再发一遍。
    """


class R2StateStore:
    def __init__(
        self,
        bucket: str,
        account_id: str = "",
        access_key_id: str = "",
        secret_access_key: str = "",
        prefix: str = "state",
        client=None,
    ):
        self.bucket = bucket
        self.account_id = account_id
        self.prefix = (prefix or "state").strip("/")
        self._client = client
        self._credentials = (account_id, access_key_id, secret_access_key)
        # 拉取时记下远端的 ETag 与内容哈希，push 时用于条件写与"跳过未变对象"
        self._etags: Dict[str, str] = {}
        self._hashes: Dict[str, str] = {}
        self._ready = False  # 远端是否已初始化过（见 _ready_key）

    # ------------------------------------------------------------------ 基础
    @property
    def client(self):
        """延迟创建的 S3 客户端（运维脚本用；业务代码只走 pull/push）。"""
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
        account, key_id, secret = self._credentials
        if not (account and key_id and secret):
            return None
        try:
            import boto3  # 延迟导入：未配置 R2 的部署不需要装也能跑
            from botocore.config import Config
        except ImportError:
            log.error("配置了 R2 但未安装 boto3（pip install boto3），本轮退回本地文件")
            return None

        self._client = boto3.client(
            "s3",
            endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
            aws_access_key_id=key_id,
            aws_secret_access_key=secret,
            region_name="auto",
            config=Config(retries={"max_attempts": 3, "mode": "standard"}, signature_version="s3v4"),
        )
        return self._client

    def key_of(self, name: str) -> str:
        return f"{self.prefix}/{name}.gz" if self.prefix else f"{name}.gz"

    def _ready_key(self) -> str:
        return f"{self.prefix}/_ready.json" if self.prefix else "_ready.json"

    # ------------------------------------------------------------------ 读
    def pull(self, data_dir: str, names=STATE_FILES) -> int:
        """把远端对象写成本地文件，返回成功拉取的个数。

        - 对象不存在（首次运行）→ 跳过，不算错误；
        - 网络 / 权限 / 桶名错误 → 收集后抛 `StateUnavailable`，
          由调用方中止运行（绝不能拿陈旧本地状态当基线，那会重复群发）。
        """
        client = self._get_client()
        if client is None:
            raise StateUnavailable("R2 已配置但客户端不可用（检查凭证与 boto3）")
        os.makedirs(data_dir, exist_ok=True)
        got = 0
        failures = []
        # 初始化标记：区分"桶里本来就没有状态"（首次运行，可用仓库里的基线）
        # 与"曾经有、现在没了"（桶被清空 / 前缀写错 —— 必须中止，否则全量重发）
        try:
            client.get_object(Bucket=self.bucket, Key=self._ready_key())
            self._ready = True
        except Exception as exc:  # noqa: BLE001
            if not _is_missing(exc):
                failures.append(f"{self._ready_key()}: {str(exc)[:120]}")
        for name in names:
            key = self.key_of(name)
            try:
                obj = client.get_object(Bucket=self.bucket, Key=key)
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
            kwargs = {
                "Bucket": self.bucket,
                "Key": key,
                "Body": body,
                "ContentType": "application/json",
                "ContentEncoding": "gzip",
            }
            etag = self._etags.get(name)
            if etag:
                kwargs["IfMatch"] = f'"{etag}"'
            try:
                resp = client.put_object(**kwargs)
            except Exception as exc:  # noqa: BLE001
                if _is_precondition(exc):
                    raise StateConflict(f"{key} 已被其他运行修改（If-Match 不匹配）") from exc
                raise
            new_etag = str((resp or {}).get("ETag") or "").strip('"')
            if new_etag:
                self._etags[name] = new_etag
            self._hashes[name] = digest
            result["uploaded"].append(name)
            log.info("R2 已上传 %s（%.1f KB）", key, len(body) / 1024)
        if not self._ready:
            # 首次写回：落下初始化标记，今后"状态全丢"能被识别出来
            try:
                client.put_object(
                    Bucket=self.bucket,
                    Key=self._ready_key(),
                    Body=b'{"version":1}',
                    ContentType="application/json",
                )
                self._ready = True
            except Exception as exc:  # noqa: BLE001 - 标记失败不阻断本轮
                log.warning("R2 初始化标记写入失败：%s", str(exc)[:120])
        return result


def _is_missing(exc: Exception) -> bool:
    code = str(getattr(exc, "response", {}).get("Error", {}).get("Code") or "")
    if code in ("NoSuchKey", "404", "NotFound"):
        return True
    text = str(exc)
    return "NoSuchKey" in text or "404" in text or "Not Found" in text


def _is_precondition(exc: Exception) -> bool:
    code = str(getattr(exc, "response", {}).get("Error", {}).get("Code") or "")
    if code in ("PreconditionFailed", "412"):
        return True
    text = str(exc)
    return "PreconditionFailed" in text or "412" in text


def build_store(settings, client=None) -> Optional[R2StateStore]:
    """按配置构造存储；缺任何一项都返回 None（=继续用本地文件 / git）。"""
    backend = (getattr(settings, "state_backend", "auto") or "auto").lower()
    if backend in ("local", "git", "off"):
        return None
    bucket = getattr(settings, "r2_bucket", "") or ""
    if not bucket:
        return None
    account = getattr(settings, "r2_account_id", "") or ""
    key_id = getattr(settings, "r2_access_key_id", "") or ""
    secret = getattr(settings, "r2_secret_access_key", "") or ""
    if backend != "r2" and not (account and key_id and secret):
        return None  # auto 模式下凭证不全就当没配
    store = R2StateStore(
        bucket=bucket,
        account_id=account,
        access_key_id=key_id,
        secret_access_key=secret,
        prefix=getattr(settings, "r2_prefix", "state") or "state",
        client=client,
    )
    return store if store.enabled else None
