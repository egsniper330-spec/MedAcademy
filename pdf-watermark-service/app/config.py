"""Service configuration loaded from environment variables (prefix PDF_SVC_).

No secret has a usable default. Missing or weak secrets stop the service at startup.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

MIN_SECRET_LENGTH = 32


def parse_hmac_keys(raw: str) -> dict[str, bytes]:
    """Parse 'keyid1:secret1,keyid2:secret2' into a mapping. Supports rotation with several active keys."""
    keys: dict[str, bytes] = {}
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if ":" not in part:
            raise ValueError("PDF_SVC_HMAC_KEYS entries must look like 'keyid:secret'")
        key_id, secret = part.split(":", 1)
        key_id = key_id.strip()
        secret = secret.strip()
        if not key_id or not key_id.replace("-", "").replace("_", "").isalnum():
            raise ValueError("HMAC key id must be alphanumeric, '-' or '_'")
        if len(secret) < MIN_SECRET_LENGTH:
            raise ValueError(f"HMAC secret for key '{key_id}' must be at least {MIN_SECRET_LENGTH} characters")
        if key_id in keys:
            raise ValueError(f"Duplicate HMAC key id '{key_id}'")
        keys[key_id] = secret.encode("utf-8")
    if not keys:
        raise ValueError("PDF_SVC_HMAC_KEYS must contain at least one key")
    return keys


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="PDF_SVC_", env_file=".env", extra="ignore")

    # Server-to-server authentication. Format: "keyid1:secret1,keyid2:secret2" (several keys allow rotation).
    hmac_keys: str = Field(..., description="Active HMAC keys, comma separated keyid:secret pairs")
    # Allowed clock difference between PHP and this service, in seconds.
    clock_skew_seconds: int = Field(300, ge=30, le=900)
    # Largest request body accepted by the internal API, in bytes.
    max_request_bytes: int = Field(1_048_576, ge=1024, le=52_428_800)

    # Private local storage root. Must not be inside a web-served directory.
    storage_root: Path = Field(Path("./data/storage"))
    # SQLite file for the job queue and nonce store.
    state_db_path: Path = Field(Path("./data/state.sqlite3"))

    # Queue controls.
    worker_count: int = Field(4, ge=1, le=6, description="Concurrent processing workers (initial target 4-6)")
    job_lease_seconds: int = Field(900, ge=60, le=86_400)
    job_max_attempts: int = Field(3, ge=1, le=10)
    job_retry_delay_seconds: int = Field(30, ge=1, le=3600)
    master_render_dpi: int = Field(150, ge=72, le=300)
    master_max_pages: int = Field(500, ge=1, le=5000)

    # Personalised issuance. The WAM checkpoint is loaded only from these fixed, operator-set paths;
    # its SHA-256 is verified before loading. Callers never supply a model path.
    wam_repo_dir: Path = Field(Path("./wam"), description="Upstream WAM repository checkout")
    wam_checkpoint: Path = Field(Path("./wam/checkpoints/wam_mit.pth"))
    wam_params_json: Path = Field(Path("./wam/checkpoints/params.json"))
    wam_runtime_url: str = Field("http://127.0.0.1:8711", description="Loopback URL of the WAM model process")
    wam_hmac_key: str = Field("", description="keyid:secret for the WAM model process (separate from API keys)")
    issuance_ttl_seconds: int = Field(86_400, ge=3600, le=604_800)
    issuance_lease_seconds: int = Field(900, ge=60, le=86_400)
    # How long an identical request waits for an in-flight generation before returning 202 'pending'.
    issuance_wait_seconds: int = Field(10, ge=0, le=60)
    # Directory for the WAM runtime's persistent replay-nonce database (see app/wam_runtime.py).
    wam_state_dir: Path = Field(Path("./wam-state"))

    # Cleanup runner (python -m app.cleanup_runner): expired-file deletion and orphan sweep interval.
    cleanup_interval_seconds: int = Field(300, ge=60, le=900)

    # Directories served by a web server (comma separated). Storage and state must not be inside them.
    web_roots: str = Field("", description="Comma separated web-served directories")

    @field_validator("hmac_keys")
    @classmethod
    def _check_keys(cls, value: str) -> str:
        parse_hmac_keys(value)  # raises on invalid input
        return value

    def hmac_key_map(self) -> dict[str, bytes]:
        return parse_hmac_keys(self.hmac_keys)

    def check_private_paths(self) -> None:
        """Raise ValueError if storage or the state DB sits inside a web-served directory."""
        roots = [Path(p.strip()).resolve() for p in self.web_roots.split(",") if p.strip()]
        for label, path in (("storage_root", self.storage_root), ("state_db_path", self.state_db_path)):
            resolved = Path(path).resolve()
            for root in roots:
                if resolved == root or root in resolved.parents:
                    raise ValueError(f"{label} must not be inside a web-served directory ({root})")


def load_settings() -> Settings:
    settings = Settings()  # type: ignore[call-arg]
    settings.check_private_paths()
    return settings
