"""
ingest_pos.py — Ingest real POS transactions from CSV into the Store Intelligence API.

Usage:
    python pipeline/ingest_pos.py \
        --csv data/pos_transactions.csv \
        --api-url http://localhost:4000
"""

import argparse
import csv
import json
import sys
import requests
import os
from dotenv import load_dotenv

load_dotenv()


def ingest_pos(csv_path: str, api_url: str, api_key: str = ''):
    transactions = []

    with open(csv_path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                transactions.append({
                    'store_id': row['store_id'],
                    'transaction_id': row['transaction_id'],
                    'timestamp': row['timestamp'],
                    'basket_value_inr': float(row['basket_value_inr']),
                })
            except (KeyError, ValueError) as e:
                print(f"[WARN] Skipping row: {e}")

    if not transactions:
        print("[WARN] No POS transactions found")
        return

    print(f"[INFO] Loaded {len(transactions)} POS transactions from {csv_path}")

    url = f"{api_url.rstrip('/')}/api/pos/ingest"
    headers = {'Content-Type': 'application/json'}
    if api_key:
        headers['X-Api-Key'] = api_key

    try:
        resp = requests.post(
            url,
            json={'transactions': transactions},
            headers=headers,
            timeout=30,
        )
        if resp.status_code == 200:
            data = resp.json()
            print(f"[OK] POS ingest: {data.get('count', 0)} transactions ingested")
        else:
            print(f"[WARN] POS ingest returned {resp.status_code}: {resp.text[:200]}")
    except requests.exceptions.RequestException as e:
        print(f"[ERROR] POS ingest failed: {e}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Ingest POS transactions CSV')
    parser.add_argument('--csv',     required=True,  help='Path to pos_transactions.csv')
    parser.add_argument('--api-url', default='http://localhost:4000')
    parser.add_argument('--api-key', default='')
    args = parser.parse_args()

    ingest_pos(args.csv, args.api_url, args.api_key or os.getenv('VISION_API_KEY', ''))
