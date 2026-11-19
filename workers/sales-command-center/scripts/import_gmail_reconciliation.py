#!/usr/bin/env python3
"""Dry-run-first, additive CRM import for Gmail history reconciliation.

Default mode is read-only. Use --apply only after reviewing the dry-run output.
The script never PATCHes existing records and requires evidence for contacts.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path


REQUIRED_COLUMNS = {"company_name", "website", "industry", "contact_name", "contact_title", "contact_email", "email_source_url", "relationship_role"}


def normalize_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.casefold())


def stable_key(kind: str, value: str) -> str:
    digest = hashlib.sha256(value.casefold().strip().encode("utf-8")).hexdigest()[:32]
    return f"historical-import-{kind}-{digest}"


@dataclass
class Api:
    base_url: str
    token: str

    def request(self, path: str, method: str = "GET", body: dict | None = None, idempotency_key: str | None = None):
        url = self.base_url.rstrip("/") + path
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            # Do not print the request headers, body, or token.
            try:
                payload = json.loads(error.read().decode("utf-8"))
            except Exception:
                payload = {"error": f"HTTP {error.code}"}
            return error.code, payload


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        missing = REQUIRED_COLUMNS - set(reader.fieldnames or [])
        if missing:
            raise ValueError("CSV missing columns: " + ", ".join(sorted(missing)))
        rows = [{key: (value or "").strip() for key, value in row.items()} for row in reader]
    if not rows:
        raise ValueError("CSV contains no rows")
    if any(not row["company_name"] for row in rows):
        raise ValueError("Every row must include company_name")
    return rows


def plan_import(rows: list[dict[str, str]], api: Api | None, apply: bool) -> list[str]:
    messages: list[str] = []
    companies: dict[str, dict] = {}
    crm_companies: list[dict] = []
    company_list_truncated = False
    if api:
        status, result = api.request("/v1/crm/companies?limit=100")
        if status != 200:
            raise RuntimeError(f"CRM company listing failed (HTTP {status})")
        crm_companies = result.get("companies", [])
        company_list_truncated = len(crm_companies) >= 100
    for row in rows:
        company_name = row["company_name"]
        norm = normalize_name(company_name)
        if norm not in companies:
            if api:
                found = crm_companies
                exact = [c for c in found if normalize_name(str(c.get("company_name", ""))) == norm]
                near = [c for c in found if normalize_name(str(c.get("company_name", ""))) and (normalize_name(str(c.get("company_name", ""))) in norm or norm in normalize_name(str(c.get("company_name", ""))))]
                if len(exact) == 1:
                    companies[norm] = {"id": exact[0]["id"], "name": exact[0]["company_name"], "existing": True}
                    messages.append(f"KEEP company: {company_name} (exact CRM match; no fields will be changed)")
                elif len(exact) > 1 or near or company_list_truncated:
                    names = ", ".join(str(c.get("company_name", "")) for c in (exact or near)) or "company list reached the 100-record API limit"
                    companies[norm] = {"ambiguous": True}
                    messages.append(f"REVIEW company: {company_name} (possible CRM match: {names}; skipped)")
                elif apply:
                    body = {"name": company_name, "website": row["website"], "industry": row["industry"]}
                    status, result = api.request("/v1/crm/companies", "POST", body, stable_key("company", norm))
                    if status == 201:
                        companies[norm] = {"id": result["id"], "name": company_name, "existing": False}
                        messages.append(f"CREATE company: {company_name}")
                    elif status == 409 and result.get("id"):
                        companies[norm] = {"id": result["id"], "name": company_name, "existing": True}
                        messages.append(f"KEEP company: {company_name} (created concurrently; no fields changed)")
                    else:
                        raise RuntimeError(f"Company creation failed for {company_name!r} (HTTP {status})")
                else:
                    companies[norm] = {"planned": True, "name": company_name}
                    messages.append(f"WOULD CREATE company: {company_name}")
            else:
                companies[norm] = {"planned": True, "name": company_name}
                messages.append(f"WOULD CHECK/CREATE company: {company_name}")

        company = companies[norm]
        name, email, source = row["contact_name"], row["contact_email"].casefold(), row["email_source_url"]
        if not any((name, email, source, row["contact_title"])):
            continue
        if not (name and email and source.startswith("https://")):
            messages.append(f"SKIP contact for {company_name}: require contact_name, contact_email, and HTTPS email_source_url")
            continue
        confidence = (row.get("confidence") or "low").lower()
        if confidence not in {"low", "medium", "high"}:
            messages.append(f"SKIP contact {email}: confidence must be low, medium, or high")
            continue
        if company.get("ambiguous"):
            messages.append(f"SKIP contact {email}: company match needs review")
            continue
        if not apply:
            messages.append(f"WOULD CREATE/LINK contact: {name} <{email}> → {company_name}; evidence: {source}")
            continue
        if not api:
            raise RuntimeError("--apply requires API access")
        company_id = company.get("id")
        if not company_id:
            raise RuntimeError(f"Company {company_name!r} was not safely resolved; cannot import contact")
        body = {"display_name": name, "title": row["contact_title"], "email": email,
                "email_source_url": source, "confidence": confidence, "company_ids": [company_id],
                "relationship_role": row["relationship_role"]}
        status, result = api.request("/v1/crm/contacts", "POST", body, stable_key("contact", email))
        if status not in (200, 201):
            raise RuntimeError(f"Contact import failed for {email} (HTTP {status})")
        messages.append(f"CREATE/LINK contact: {name} <{email}> → {company_name} (matched_existing={bool(result.get('matched_existing'))})")
    return messages


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_file", type=Path)
    parser.add_argument("--apply", action="store_true", help="write new companies/contacts after reviewing a dry run")
    args = parser.parse_args()
    try:
        rows = load_rows(args.csv_file)
        url, token = os.getenv("CRM_IMPORT_WORKER_URL", "").strip(), os.getenv("CRM_IMPORT_TOKEN", "")
        api = None
        if url and token:
            if not url.startswith("https://"):
                raise ValueError("CRM_IMPORT_WORKER_URL must use HTTPS")
            api = Api(url, token)
        elif args.apply:
            raise ValueError("--apply requires CRM_IMPORT_WORKER_URL and CRM_IMPORT_TOKEN environment variables")
        if api is None:
            print("NOTE: no API credentials supplied; producing a local-only preview without checking CRM duplicates.")
        for line in plan_import(rows, api, args.apply):
            print(line)
        print("Mode: APPLY" if args.apply else "Mode: DRY RUN (no writes)")
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Import stopped safely: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
