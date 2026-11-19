import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("import_gmail_reconciliation.py")
spec = importlib.util.spec_from_file_location("gmail_import", SCRIPT)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class FakeApi:
    def __init__(self):
        self.companies = [{"id": "company-existing", "company_name": "Kwik Trip", "website": "https://old.example", "industry": "Existing"}]
        self.contacts = {}
        self.links = set()
        self.idempotency = {}
        self.writes = []

    def request(self, path, method="GET", body=None, idempotency_key=None):
        if method == "GET":
            query = path.split("?", 1)[1]
            from urllib.parse import parse_qs
            q = parse_qs(query).get("q", [""])[0].casefold()
            return 200, {"companies": [c for c in self.companies if q in c["company_name"].casefold()]}
        if idempotency_key in self.idempotency:
            return self.idempotency[idempotency_key]
        self.writes.append((path, method, body.copy()))
        if path == "/v1/crm/companies":
            row = {"id": "company-new", "company_name": body["name"], **body}
            self.companies.append(row)
            result = (201, {"id": row["id"], "company_name": row["company_name"]})
        elif path == "/v1/crm/contacts":
            email = body["email"].casefold()
            existed = email in self.contacts
            if not existed:
                self.contacts[email] = {"id": f"contact-{len(self.contacts)+1}", **body}
            self.links.add((email, body["company_ids"][0]))
            result = (200 if existed else 201, {"id": self.contacts[email]["id"], "matched_existing": existed})
        else:
            raise AssertionError(path)
        self.idempotency[idempotency_key] = result
        return result


def row(company, name, email, company_url="https://kwiktrip.example/about"):
    return {"company_name": company, "website": "", "industry": "", "contact_name": name,
            "contact_title": "Marketing", "contact_email": email,
            "email_source_url": company_url, "relationship_role": "Marketing"}


class ImportTests(unittest.TestCase):
    def test_dry_run_never_writes(self):
        api = FakeApi()
        result = module.plan_import([row("Kwik Trip", "A Person", "a@example.com")], api, False)
        self.assertTrue(any("KEEP company" in line for line in result))
        self.assertEqual(api.writes, [])

    def test_multiple_contacts_same_company_and_rerun_are_idempotent(self):
        api = FakeApi()
        rows = [row("Kwik Trip", "A Person", "a@example.com"), row("Kwik Trip", "B Person", "b@example.com")]
        module.plan_import(rows, api, True)
        self.assertEqual(len(api.contacts), 2)
        self.assertEqual(len(api.links), 2)
        self.assertEqual(api.companies[0]["website"], "https://old.example", "existing CRM fields are never overwritten")
        writes = len(api.writes)
        module.plan_import(rows, api, True)
        self.assertEqual(len(api.writes), writes)

    def test_contact_without_source_evidence_is_skipped(self):
        api = FakeApi()
        result = module.plan_import([row("Kwik Trip", "A Person", "a@example.com", "")], api, True)
        self.assertTrue(any("SKIP contact" in line for line in result))
        self.assertEqual(api.contacts, {})


if __name__ == "__main__":
    unittest.main()
