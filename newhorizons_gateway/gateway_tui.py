from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from textual.app import App, ComposeResult
from textual.containers import Vertical
from textual.widgets import Footer, Header, RichLog, Static

from .console_runtime import format_console_header_lines, read_console_status


class GatewayConsoleApp(App[None]):
    CSS = """
    Screen {
        layout: vertical;
    }

    #status-panel {
        height: 10;
        border: round #3f7b61;
        padding: 0 1;
        background: #0f1611;
        color: #dfeee2;
    }

    #event-panel {
        height: 1fr;
        border: round #5f6c62;
    }
    """

    BINDINGS = [("ctrl+c", "quit", "Quit")]

    def __init__(
        self,
        *,
        status_file: Path,
        version: str,
        config_path: Path,
        log_path: Path,
        on_ready: Callable[["GatewayConsoleApp"], None] | None = None,
    ) -> None:
        super().__init__()
        self.status_file = status_file
        self.version = version
        self.config_path = config_path
        self.log_path = log_path
        self.on_ready = on_ready
        self._status_file_mtime_ns = -1
        self._status: dict[str, Any] = {}
        self._status_poll_count = 0
        self.exit_code = 0

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        with Vertical():
            yield Static("", id="status-panel")
            yield RichLog(id="event-panel", wrap=True, highlight=False, markup=False, auto_scroll=True)
        yield Footer()

    def on_mount(self) -> None:
        self.set_interval(0.35, self._refresh_status)
        self._refresh_status()
        if self.on_ready is not None:
            self.run_worker(lambda: self.on_ready(self), thread=True, exclusive=True)

    def record_status_poll(self) -> None:
        self._status_poll_count += 1
        self._render_status()

    def push_log_line(self, line: str) -> None:
        widget = self.query_one("#event-panel", RichLog)
        widget.write(line.rstrip())

    def _refresh_status(self) -> None:
        try:
            stat = self.status_file.stat()
        except FileNotFoundError:
            self._render_status()
            return
        if stat.st_mtime_ns != self._status_file_mtime_ns:
            self._status = read_console_status(self.status_file.parents[1])
            self._status_file_mtime_ns = stat.st_mtime_ns
        self._render_status()

    def _render_status(self) -> None:
        status = dict(self._status)
        status["status_poll_count"] = self._status_poll_count
        lines = format_console_header_lines(
            status,
            version=self.version,
            config_path=self.config_path,
            log_path=self.log_path,
        )
        panel = self.query_one("#status-panel", Static)
        panel.update("\n".join(lines))

    def finish(self, exit_code: int = 0) -> None:
        self.exit_code = exit_code
        self.exit()
