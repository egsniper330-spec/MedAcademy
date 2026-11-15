"""Early-exit page scanning for /internal/detect.

These tests exercise the real `scan_pages()` orchestration with stubbed page rendering and
payload extraction, so the PAGE ACCOUNTING is measured exactly — which is the property the
optimization is about. No model, no Torch, no PDF is needed: `render_page` records every
index it is asked for, so "a later page was never rendered" is directly observable.
"""

from __future__ import annotations

import pytest

from app.main import scan_pages

PAYLOAD_A = 3_434_497_470
PAYLOAD_B = 92_930_038


class Probe:
    """Records which pages were rendered and in what order."""

    def __init__(self, readings: list[tuple[int | None, float]]):
        self.readings = readings
        self.rendered: list[int] = []

    def render_page(self, index: int):
        self.rendered.append(index)
        return ("bitmap", index)  # opaque to scan_pages

    def extract(self, bitmap) -> tuple[int | None, float]:
        _, index = bitmap
        return self.readings[index]


def run(readings: list[tuple[int | None, float]], total: int | None = None) -> tuple[dict, Probe]:
    probe = Probe(readings)
    result = scan_pages(len(readings) if total is None else total, probe.render_page, probe.extract)
    return result, probe


def test_complete_mark_on_page_one_stops_after_one_page():
    result, probe = run([(PAYLOAD_A, 0.97), (PAYLOAD_A, 0.97), (PAYLOAD_A, 0.96)])

    assert probe.rendered == [0], "pages 2 and 3 must never be rendered"
    assert result["pages_analyzed"] == 1
    assert result["pages_total"] == 3
    assert result["verdict"] == "confirmed"
    assert result["payload"] == PAYLOAD_A
    assert result["agreement"] == 1.0
    assert result["stopped_early"] is True


def test_unreadable_page_one_then_complete_page_two_uses_exactly_two_pages():
    result, probe = run([(None, 0.51), (PAYLOAD_A, 0.95), (PAYLOAD_A, 0.95), (PAYLOAD_A, 0.95)])

    assert probe.rendered == [0, 1]
    assert result["pages_analyzed"] == 2
    assert result["verdict"] == "confirmed"
    assert result["payload"] == PAYLOAD_A
    assert result["stopped_early"] is True


def test_incomplete_pages_one_and_two_then_complete_page_three_uses_exactly_three():
    result, probe = run([(None, 0.50), (None, 0.55), (PAYLOAD_B, 0.94), (PAYLOAD_B, 0.94)])

    assert probe.rendered == [0, 1, 2]
    assert result["pages_analyzed"] == 3
    assert result["verdict"] == "confirmed"
    assert result["payload"] == PAYLOAD_B


def test_no_complete_result_anywhere_scans_every_page():
    readings = [(None, 0.50)] * 5
    result, probe = run(readings)

    assert probe.rendered == [0, 1, 2, 3, 4]
    assert result["pages_analyzed"] == 5
    assert result["verdict"] == "no_mark"
    assert result["payload"] is None
    assert result["stopped_early"] is False


def test_low_confidence_mark_does_not_stop_the_scan():
    # Above the "probable" bar but below the confirm bar: keep looking for corroboration.
    readings = [(PAYLOAD_A, 0.82)] * 4
    result, probe = run(readings)

    assert probe.rendered == [0, 1, 2, 3]
    assert result["pages_analyzed"] == 4
    assert result["verdict"] == "probable"
    assert result["stopped_early"] is False


def test_partial_or_corrupt_pages_never_produce_a_premature_success():
    # A weak first read must not be treated as the answer; a page that disagrees with it
    # keeps the scan going, and the split vote never reaches "confirmed".
    result, probe = run([(PAYLOAD_A, 0.82), (PAYLOAD_B, 0.95), (PAYLOAD_A, 0.93)])

    assert probe.rendered == [0, 1, 2]
    assert result["pages_analyzed"] == 3
    assert result["stopped_early"] is False, "disagreeing pages must not stop the scan"
    assert result["payload"] == PAYLOAD_A
    assert result["verdict"] == "probable"          # 2/3 readable votes, below the confirm bar


def test_ambiguous_spread_keeps_the_existing_safe_verdict():
    # Four readable pages, four different payloads → no identification is claimed.
    readings = [(1, 0.85), (2, 0.95), (3, 0.95), (4, 0.95)]
    result, probe = run(readings)

    assert probe.rendered == [0, 1, 2, 3]
    assert result["verdict"] == "ambiguous"
    assert result["payload"] is not None  # legacy contract: winner is reported with the warning
    assert result["agreement"] == 0.25


def test_a_strong_first_page_ends_the_scan_before_an_unreadable_page_is_seen():
    # By design: once page 1 alone is sufficient, later pages are never rendered — so a
    # later unreadable page cannot retroactively invalidate the result, and its cost is
    # never paid. This is the intended consequence of the early-exit contract.
    result, probe = run([(PAYLOAD_A, 0.99), (None, 0.49), (PAYLOAD_A, 0.99)])

    assert probe.rendered == [0]
    assert result["pages_analyzed"] == 1
    assert result["verdict"] == "confirmed"
    assert result["stopped_early"] is True


def test_pages_after_the_successful_page_are_never_rendered_even_in_a_long_document():
    readings = [(PAYLOAD_A, 0.98)] + [(PAYLOAD_A, 0.98)] * 39
    result, probe = run(readings)

    assert probe.rendered == [0]
    assert result["pages_analyzed"] == 1
    assert result["pages_total"] == 40
    assert result["stopped_early"] is True


def test_scan_is_sequential_and_never_reprocesses_a_page():
    readings = [(None, 0.5), (None, 0.5), (PAYLOAD_A, 0.96)]
    result, probe = run(readings)

    assert probe.rendered == [0, 1, 2]
    assert len(probe.rendered) == len(set(probe.rendered)), "no page may be rendered twice"


def test_single_page_document_has_nothing_to_exit_from():
    result, probe = run([(PAYLOAD_A, 0.97)])

    assert probe.rendered == [0]
    assert result["pages_analyzed"] == 1
    assert result["pages_total"] == 1
    assert result["verdict"] == "confirmed"
    assert result["stopped_early"] is False  # nothing was skipped, so it is not an early exit
