"""Cleanup runner: single-instance lock and configuration bounds."""

from __future__ import annotations

import pytest

from app import cleanup_runner


def test_second_lock_on_same_file_is_refused(tmp_path):
    path = tmp_path / "cleanup.lock"
    first = cleanup_runner._acquire_lock(path)
    try:
        with pytest.raises(cleanup_runner.AlreadyRunning):
            cleanup_runner._acquire_lock(path)
    finally:
        first.close()


def test_lock_is_reacquirable_after_release(tmp_path):
    path = tmp_path / "cleanup.lock"
    cleanup_runner._acquire_lock(path).close()
    handle = cleanup_runner._acquire_lock(path)
    handle.close()


def test_interval_bounds(monkeypatch):
    monkeypatch.setenv(cleanup_runner.ENV_INTERVAL, "30")
    with pytest.raises(ValueError):
        cleanup_runner._interval()
    monkeypatch.setenv(cleanup_runner.ENV_INTERVAL, "300")
    assert cleanup_runner._interval() == 300
