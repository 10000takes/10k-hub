import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("collect_x", ROOT / "collect_x.py")
collect_x = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collect_x)


class MainAccountDailyCollectorTests(unittest.TestCase):
    def test_daily_mode_requests_and_saves_only_main_account(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "followers.csv"
            with mock.patch.object(collect_x, "OUTPUT_FILE", str(output)), \
                 mock.patch.object(collect_x, "fetch_followers", return_value=({"10k_takes": 1234}, [])) as fetch, \
                 mock.patch.dict("os.environ", {"X_BEARER_TOKEN": "placeholder"}), \
                 mock.patch("sys.argv", ["collect_x.py", "--main-account-only"]):
                collect_x.main()
            requested = fetch.call_args.args[1]
            self.assertEqual(requested, {"10K_Takes": "10K Takes"})
            self.assertIn("10K Takes", output.read_text())
            self.assertNotIn("Wild Takes", output.read_text())

    def test_weekly_default_still_requests_all_configured_accounts(self):
        with mock.patch.object(collect_x, "fetch_followers", return_value=({"10k_takes": 1234}, [])) as fetch, \
             mock.patch.object(collect_x, "save_rows"), \
             mock.patch.dict("os.environ", {"X_BEARER_TOKEN": "placeholder"}), \
             mock.patch("sys.argv", ["collect_x.py"]):
            with self.assertRaises(SystemExit):
                collect_x.main()
        self.assertEqual(fetch.call_args.args[1], collect_x.HANDLES)


if __name__ == "__main__":
    unittest.main()
