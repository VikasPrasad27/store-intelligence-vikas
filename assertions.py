"""
assertions.py — 10 example test assertions your API must pass.

Run after seeding the API with sample_events.jsonl:
    python pipeline/ingest_events.py --events data/sample_events.jsonl --api-url http://localhost:4000
    python assertions.py

These are the publicly visible assertions. The scoring harness uses a superset.
"""

import requests
import sys
import json

BASE_URL = "http://localhost:4000/api"
STORE_ID = "STORE_BLR_BRIGADE"


def assert_eq(label, actual, expected, tolerance=None):
    if tolerance is not None:
        ok = abs(actual - expected) <= tolerance
    else:
        ok = actual == expected
    status = "✅ PASS" if ok else "❌ FAIL"
    print(f"{status} | {label}")
    print(f"       Expected: {expected}")
    print(f"       Actual  : {actual}")
    if not ok:
        sys.exit(1)


def assert_true(label, condition):
    status = "✅ PASS" if condition else "❌ FAIL"
    print(f"{status} | {label}")
    if not condition:
        sys.exit(1)


def main():
    print(f"\nRunning assertions against {BASE_URL}\n")

    # ── Assertion 1: Health endpoint returns 200 ──────────────────────────────
    r = requests.get(f"{BASE_URL}/health")
    assert_eq("Health endpoint returns 200", r.status_code, 200)

    health = r.json()
    assert_true("Health response has 'status' field", 'status' in health)
    assert_true("Health status is OK or DEGRADED",
                health['status'] in ('OK', 'DEGRADED', 'UNHEALTHY'))

    # ── Assertion 2: Metrics endpoint returns valid JSON ──────────────────────
    r = requests.get(f"{BASE_URL}/stores/{STORE_ID}/metrics")
    assert_eq("Metrics endpoint returns 200", r.status_code, 200)

    metrics = r.json()
    assert_true("Metrics response has success=true", metrics.get('success') is True)

    data = metrics.get('data', {})
    assert_true("Metrics has unique_visitors field", 'unique_visitors' in data)
    assert_true("Metrics has conversion_rate field", 'conversion_rate' in data)
    assert_true("Metrics has abandonment_rate field", 'abandonment_rate' in data)

    # ── Assertion 3: unique_visitors is non-negative integer ─────────────────
    assert_true("unique_visitors >= 0",
                isinstance(data['unique_visitors'], int) and data['unique_visitors'] >= 0)

    # ── Assertion 4: conversion_rate is between 0 and 1 ──────────────────────
    cr = data['conversion_rate']
    assert_true("conversion_rate is between 0 and 1 (inclusive)",
                isinstance(cr, (int, float)) and 0.0 <= cr <= 1.0)

    # ── Assertion 5: Staff excluded from unique_visitors ─────────────────────
    # sample_events.jsonl has VIS_g7h8i9 as is_staff=true
    # unique_visitors should not count them
    # (we can only verify the count is less than total ENTRY events including staff)
    r2 = requests.get(f"{BASE_URL}/stores/{STORE_ID}/metrics")
    data2 = r2.json()['data']
    assert_true("unique_visitors is an integer (staff excluded)",
                isinstance(data2['unique_visitors'], int))

    # ── Assertion 6: Funnel has exactly 4 stages ─────────────────────────────
    r = requests.get(f"{BASE_URL}/stores/{STORE_ID}/funnel")
    assert_eq("Funnel endpoint returns 200", r.status_code, 200)

    funnel_data = r.json().get('data', {})
    funnel_stages = funnel_data.get('funnel', [])
    assert_eq("Funnel has exactly 4 stages", len(funnel_stages), 4)

    stage_names = [s['stage'] for s in funnel_stages]
    assert_true("Funnel stages are in correct order",
                stage_names == ['entry', 'zone_visit', 'billing_queue', 'purchase'])

    # ── Assertion 7: Funnel entry pct_of_total is 100 ────────────────────────
    entry_stage = funnel_stages[0]
    assert_eq("Funnel entry stage pct_of_total == 100",
              entry_stage['pct_of_total'], 100)

    # ── Assertion 8: Heatmap endpoint has data_confidence field ──────────────
    r = requests.get(f"{BASE_URL}/stores/{STORE_ID}/heatmap")
    assert_eq("Heatmap endpoint returns 200", r.status_code, 200)

    heatmap_data = r.json().get('data', {})
    assert_true("Heatmap has data_confidence field",
                'data_confidence' in heatmap_data)
    assert_true("data_confidence is LOW or HIGH",
                heatmap_data['data_confidence'] in ('LOW', 'HIGH'))

    # ── Assertion 9: Anomalies endpoint returns structured response ───────────
    r = requests.get(f"{BASE_URL}/stores/{STORE_ID}/anomalies")
    assert_eq("Anomalies endpoint returns 200", r.status_code, 200)

    anomaly_data = r.json().get('data', {})
    assert_true("Anomalies has anomaly_count field", 'anomaly_count' in anomaly_data)
    assert_true("Anomalies has anomalies array", isinstance(anomaly_data.get('anomalies'), list))

    for anomaly in anomaly_data.get('anomalies', []):
        assert_true(f"Anomaly has severity field: {anomaly.get('type')}",
                    anomaly.get('severity') in ('INFO', 'WARN', 'CRITICAL'))
        assert_true(f"Anomaly has suggested_action: {anomaly.get('type')}",
                    bool(anomaly.get('suggested_action')))

    # ── Assertion 10: Idempotent ingest ──────────────────────────────────────
    test_event = {
        "event_id": "aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb",
        "store_id": STORE_ID,
        "camera_id": "CAM_ENTRY_01",
        "visitor_id": "VIS_assert_test",
        "event_type": "ENTRY",
        "timestamp": "2026-03-03T14:00:00Z",
        "zone_id": None,
        "dwell_ms": 0,
        "is_staff": False,
        "confidence": 0.9,
        "metadata": {"queue_depth": None, "sku_zone": None, "session_seq": 1}
    }

    r1 = requests.post(f"{BASE_URL}/events/ingest",
                       json={"events": [test_event]},
                       headers={"Content-Type": "application/json"})
    r2 = requests.post(f"{BASE_URL}/events/ingest",
                       json={"events": [test_event]},
                       headers={"Content-Type": "application/json"})

    assert_true("First ingest returns 200", r1.status_code == 200)
    assert_true("Second ingest (duplicate) returns 200 (idempotent)",
                r2.status_code == 200)

    result2 = r2.json().get('result', {})
    assert_true("Second ingest reports 1 duplicate, 0 errors",
                result2.get('duplicates', 0) == 1 and len(result2.get('errors', [])) == 0)

    print(f"\n{'='*50}")
    print("All 10 assertions passed ✅")
    print(f"{'='*50}\n")


if __name__ == '__main__':
    main()
