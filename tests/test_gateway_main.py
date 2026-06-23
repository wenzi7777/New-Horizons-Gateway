import unittest
from unittest.mock import patch

from newhorizons_gateway import main as gateway_main


class GatewayMainTest(unittest.TestCase):
    def test_signal_handlers_are_skipped_outside_main_thread(self):
        with patch("newhorizons_gateway.main.threading.current_thread", return_value=object()), \
             patch("newhorizons_gateway.main.threading.main_thread", return_value=object()), \
             patch("newhorizons_gateway.main.signal.signal") as register:
            gateway_main._install_signal_handlers(lambda *_args: None)

        register.assert_not_called()

    def test_signal_handlers_are_installed_on_main_thread(self):
        marker = object()
        with patch("newhorizons_gateway.main.threading.current_thread", return_value=marker), \
             patch("newhorizons_gateway.main.threading.main_thread", return_value=marker), \
             patch("newhorizons_gateway.main.signal.signal") as register:
            gateway_main._install_signal_handlers(lambda *_args: None)

        self.assertEqual(register.call_count, 2)


if __name__ == "__main__":
    unittest.main()
